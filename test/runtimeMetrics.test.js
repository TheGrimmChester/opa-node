'use strict';

// Runtime metric tests.
//
// The properties pinned here are the ones a silent mistake would hide: that GC is
// reported as a DELTA per kind (a cumulative counter emitted as a delta, or the
// reverse, makes every derived rate wrong), that the event-loop histogram is reset
// each interval, and that nothing here can throw into the application.

const assert = require('assert');
const { RuntimeMetrics, gcKindName } = require('../lib/runtimeMetrics');
const { resolveConfig } = require('../lib/config');

function fakeState(overrides) {
  const sent = [];
  return Object.assign({
    config: resolveConfig({ service: 'svc-under-test' }),
    transport: { send: (line) => sent.push(line) },
    sent,
  }, overrides);
}

// Yield to the event loop so monitorEventLoopDelay can record samples.
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function byName(points) {
  const out = {};
  for (const p of points) {
    let key = p.name;
    for (const l of ['quantile', 'kind', 'space', 'resource_type']) {
      if (p.labels && p.labels[l]) key += `{${l}=${p.labels[l]}}`;
    }
    out[key] = p;
  }
  return out;
}

const tests = {
  'defaults on, interval floored'() {
    const c = resolveConfig({});
    assert.strictEqual(c.runtimeMetrics, true, 'should default on');
    assert.strictEqual(c.runtimeMetricsIntervalMs, 15000);
    // A sub-second interval would make the reporter the load.
    assert.strictEqual(resolveConfig({ runtimeMetricsIntervalMs: 10 }).runtimeMetricsIntervalMs, 15000);
    assert.strictEqual(resolveConfig({ runtimeMetricsIntervalMs: 'x' }).runtimeMetricsIntervalMs, 15000);
    assert.strictEqual(resolveConfig({ runtimeMetricsIntervalMs: 30000 }).runtimeMetricsIntervalMs, 30000);
    assert.strictEqual(resolveConfig({ runtimeMetrics: false }).runtimeMetrics, false);
  },

  async 'collects event loop, heap and identity'() {
    const rm = new RuntimeMetrics(fakeState(), 1000);
    rm.start();
    // monitorEventLoopDelay only records a sample when the loop TICKS. A
    // synchronous test never yields, so the histogram stays empty and mean is
    // NaN — which collect() correctly omits rather than reporting as a value.
    await tick(60);
    const points = byName(rm.collect());
    rm.stop();

    // Event-loop delay is the signal a span can never show: a request that waited
    // on a blocked loop records its own fast execution, not the wait.
    assert.ok(points['nodejs.eventloop.delay{quantile=p99}'], 'p99 loop delay missing');
    assert.ok(points['nodejs.eventloop.delay{quantile=mean}'], 'mean loop delay missing');
    assert.ok(points['nodejs.eventloop.delay.max'], 'max loop delay missing');
    assert.ok(points['nodejs.eventloop.utilization'], 'loop utilization missing');

    // heap.limit is what OOM is measured against, so the ratio predicts a crash.
    assert.ok(points['nodejs.heap.limit'], 'heap limit missing');
    assert.ok(points['nodejs.heap.utilization'], 'heap utilization missing');
    const util = points['nodejs.heap.utilization'].value;
    assert.ok(util > 0 && util < 1, `heap utilization ${util} should be a ratio`);

    // Per-space is where a leak becomes legible: old_space growing while
    // new_space is flat is retention, not churn.
    assert.ok(points['nodejs.heap.space.used{space=old_space}'], 'old_space missing');
    assert.ok(points['nodejs.heap.space.used{space=new_space}'], 'new_space missing');

    const info = points['nodejs.runtime.info'];
    assert.ok(info && info.value === 1, 'info metric should carry facts in labels, value 1');
    assert.ok(info.labels.version, 'info should report the node version');
  },

  async 'event loop delay detects a real stall'() {
    const rm = new RuntimeMetrics(fakeState(), 1000);
    rm.start();
    await tick(40);
    // Block the loop, then yield so the histogram actually records the delay.
    // The idle baseline is the histogram resolution (~20ms), so a stall must be
    // clearly separable from it or the metric is useless.
    const end = Date.now() + 250;
    while (Date.now() < end) { /* spin */ }
    await tick(40);
    const points = byName(rm.collect());
    rm.stop();
    const max = points['nodejs.eventloop.delay.max'].value;
    assert.ok(max > 150, `loop delay max ${max}ms should reflect a 250ms block`);
  },

  async 'event loop histogram resets each interval'() {
    const rm = new RuntimeMetrics(fakeState(), 1000);
    rm.start();
    await tick(40);
    const end = Date.now() + 200;
    while (Date.now() < end) { /* spin */ }
    await tick(40);
    const first = byName(rm.collect())['nodejs.eventloop.delay.max'].value;
    assert.ok(first > 100, `first sample should see the block, got ${first}ms`);

    // Without a reset the histogram is cumulative since start, so a stall an hour
    // ago keeps inflating p99 forever and reads as an ongoing problem.
    await tick(40);
    const second = byName(rm.collect())['nodejs.eventloop.delay.max'].value;
    rm.stop();
    assert.ok(second < first, `histogram not reset: ${second}ms still reflects the earlier ${first}ms block`);
  },

  'GC is delta-typed, per kind, and cleared after reporting'() {
    const state = fakeState();
    const rm = new RuntimeMetrics(state, 1000);
    // Inject observed GC events rather than trying to force V8 to collect, which
    // is not reliably triggerable from a test.
    rm.gcCounts = { scavenge: 3, mark_sweep_compact: 1 };
    rm.gcDurations = { scavenge: 4.5, mark_sweep_compact: 12.25 };

    const points = byName(rm.collect());
    const scav = points['nodejs.gc.collections{kind=scavenge}'];
    assert.ok(scav, 'per-kind GC collections missing');
    // A scavenge storm and a run of mark-sweeps are different problems, so the
    // kinds must stay separate.
    assert.ok(points['nodejs.gc.collections{kind=mark_sweep_compact}'], 'mark-sweep kind missing');
    assert.strictEqual(scav.type, 'delta',
      'GC must be typed delta: it is accumulated since the last report, not cumulative since start');
    assert.strictEqual(scav.value, 3);
    assert.strictEqual(points['nodejs.gc.duration{kind=scavenge}'].value, 4.5);

    rm.report();
    // Carrying accumulators forward would count the same collections again on
    // every subsequent report.
    assert.deepStrictEqual(rm.gcCounts, Object.create(null));
    assert.deepStrictEqual(rm.gcDurations, Object.create(null));
  },

  'report shape and service label'() {
    const state = fakeState();
    state.config.organizationId = 'org1';
    state.config.projectId = 'proj1';
    const rm = new RuntimeMetrics(state, 1000);
    rm.report();

    assert.strictEqual(state.sent.length, 1);
    const line = state.sent[0];
    assert.strictEqual(line.type, 'metric');
    assert.strictEqual(line.organization_id, 'org1');
    assert.strictEqual(line.project_id, 'proj1');
    assert.ok(line.metrics.length > 0);
    // Without the service label a runtime metric cannot be tied to the spans from
    // the same process, which is the whole reason to collect it.
    for (const p of line.metrics) {
      assert.strictEqual(p.labels.service, 'svc-under-test', `${p.name} missing service label`);
    }
  },

  'no transport is a silent no-op'() {
    const rm = new RuntimeMetrics({ config: resolveConfig({}), transport: null }, 1000);
    rm.report(); // must not throw
    const rm2 = new RuntimeMetrics({}, 1000);
    rm2.report(); // nor with no config at all
  },

  async 'all values are finite'() {
    const rm = new RuntimeMetrics(fakeState(), 1000);
    rm.start();
    await tick(40);
    for (const p of rm.collect()) {
      assert.ok(Number.isFinite(p.value), `${p.name} produced ${p.value}`);
    }
    rm.stop();
  },

  'timer is unref so it never holds the process open'() {
    const rm = new RuntimeMetrics(fakeState(), 1000);
    rm.start();
    // A monitoring agent must not change the lifetime of what it monitors.
    assert.ok(rm.timer, 'timer should exist');
    assert.strictEqual(typeof rm.timer.hasRef, 'function');
    assert.strictEqual(rm.timer.hasRef(), false, 'reporter timer must be unref()d');
    rm.stop();
    assert.strictEqual(rm.timer, null);
    rm.stop(); // idempotent
  },

  'gc kind names are human readable'() {
    assert.strictEqual(gcKindName(1), 'scavenge');
    assert.strictEqual(gcKindName(4), 'mark_sweep_compact');
    assert.strictEqual(gcKindName(8), 'incremental_marking');
    // An unknown numeric flag must not leak into a chart as a bare integer.
    assert.strictEqual(gcKindName(999), 'other');
    assert.strictEqual(gcKindName(undefined), 'other');
  },
};

(async () => {
  let failures = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn();
      console.log('  PASS ' + name);
    } catch (e) {
      failures++;
      console.log('  FAIL ' + name + ': ' + e.message);
    }
  }
  console.log('\n' + failures + ' failure(s)');
  process.exit(failures ? 1 : 0);
})();
