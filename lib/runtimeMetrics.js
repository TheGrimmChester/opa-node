'use strict';

// Node.js runtime metrics.
//
// EVERY NUMBER HERE IS UNREACHABLE FROM OUTSIDE THE PROCESS. A host collector can
// see that a Node process is using 400 MB of RSS and one CPU; it cannot see that
// the event loop is 800 ms behind, that old-space is 95% full and GC is running
// continuously, or that the app is holding 40,000 sockets open. Those are the
// numbers that explain a Node service whose spans all look fine while requests
// queue — so they have to be collected in-process, which is what this module does.
//
// It rides the same ND-JSON socket as spans and logs, as a {"type":"metric"} batch,
// so no new port or protocol is involved.

const v8 = require('v8');
const perf_hooks = require('perf_hooks');

const DEFAULT_INTERVAL_MS = 15000;
// The event-loop delay histogram is sampled at this resolution. 20ms is fine
// enough to see a stall that matters and coarse enough to cost nothing.
const ELD_RESOLUTION_MS = 20;

/**
 * Runtime metric reporter. Created by start() when enabled.
 */
class RuntimeMetrics {
  constructor(state, intervalMs) {
    this.state = state;
    this.intervalMs = intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS;
    this.timer = null;
    this.eld = null;
    this.gcObserver = null;
    this.lastElu = null;
    // GC is observed as events and accumulated into counters, because a
    // point-in-time GC reading does not exist — what matters is how much time was
    // spent collecting since the last report.
    this.gcCounts = Object.create(null);
    this.gcDurations = Object.create(null);
  }

  start() {
    // monitorEventLoopDelay is the only accurate way to measure loop lag: timing a
    // setTimeout from JS measures the delay AND the measurement's own scheduling,
    // and it stops reporting entirely while the loop is genuinely blocked.
    try {
      this.eld = perf_hooks.monitorEventLoopDelay({ resolution: ELD_RESOLUTION_MS });
      this.eld.enable();
    } catch (e) {
      this.eld = null;
    }

    try {
      this.gcObserver = new perf_hooks.PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          // entry.detail.kind is the numeric GC type on modern Node; the older
          // entry.kind is kept as a fallback.
          const kind = gcKindName((entry.detail && entry.detail.kind) || entry.kind);
          this.gcCounts[kind] = (this.gcCounts[kind] || 0) + 1;
          this.gcDurations[kind] = (this.gcDurations[kind] || 0) + entry.duration;
        }
      });
      this.gcObserver.observe({ entryTypes: ['gc'] });
    } catch (e) {
      this.gcObserver = null;
    }

    // Prime the ELU baseline so the first report is a real utilisation figure
    // rather than utilisation since process start.
    try {
      this.lastElu = perf_hooks.performance.eventLoopUtilization();
    } catch (e) {
      this.lastElu = null;
    }

    this.timer = setInterval(() => this.report(), this.intervalMs);
    // unref so the reporter never keeps a process alive that would otherwise
    // exit — a monitoring agent must not change the lifetime of the thing it
    // monitors. Matches the transport's discipline.
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.eld) {
      try { this.eld.disable(); } catch (e) { /* ignore */ }
      this.eld = null;
    }
    if (this.gcObserver) {
      try { this.gcObserver.disconnect(); } catch (e) { /* ignore */ }
      this.gcObserver = null;
    }
  }

  /**
   * Collect one sample set. Exposed separately from the timer so tests can call
   * it directly rather than waiting on an interval.
   * @returns {Array<object>} metric points
   */
  collect() {
    const points = [];
    const now = Date.now();
    const add = (name, value, type, unit, labels) => {
      if (value == null || !Number.isFinite(value)) return;
      const p = { name, type: type || 'gauge', value, timestamp_ms: now };
      if (unit) p.unit = unit;
      if (labels) p.labels = labels;
      points.push(p);
    };

    // --- Event loop ---------------------------------------------------------
    if (this.eld) {
      // Nanoseconds from the histogram; reported in milliseconds because that is
      // the unit every Node latency figure is discussed in.
      const ns2ms = (v) => (Number.isFinite(v) ? v / 1e6 : null);
      add('nodejs.eventloop.delay', ns2ms(this.eld.mean), 'gauge', 'ms', { quantile: 'mean' });
      add('nodejs.eventloop.delay', ns2ms(this.eld.percentile(50)), 'gauge', 'ms', { quantile: 'p50' });
      add('nodejs.eventloop.delay', ns2ms(this.eld.percentile(95)), 'gauge', 'ms', { quantile: 'p95' });
      add('nodejs.eventloop.delay', ns2ms(this.eld.percentile(99)), 'gauge', 'ms', { quantile: 'p99' });
      add('nodejs.eventloop.delay.max', ns2ms(this.eld.max), 'gauge', 'ms');
      // Reset so each report describes ITS interval. Without this the histogram
      // is cumulative since start and a stall an hour ago keeps inflating p99
      // forever, which reads as an ongoing problem.
      try { this.eld.reset(); } catch (e) { /* ignore */ }
    }

    // Event-loop utilisation: the fraction of wall time the loop spent working
    // rather than waiting. Unlike CPU%, it is specific to the loop, so a value
    // near 1 means the loop is the bottleneck even on an idle-looking host.
    try {
      const elu = perf_hooks.performance.eventLoopUtilization(this.lastElu);
      if (elu && Number.isFinite(elu.utilization)) {
        add('nodejs.eventloop.utilization', elu.utilization, 'gauge', '1');
      }
      this.lastElu = perf_hooks.performance.eventLoopUtilization();
    } catch (e) { /* ignore */ }

    // --- Heap --------------------------------------------------------------
    try {
      const hs = v8.getHeapStatistics();
      add('nodejs.heap.used', hs.used_heap_size, 'gauge', 'By');
      add('nodejs.heap.total', hs.total_heap_size, 'gauge', 'By');
      // heap_size_limit is what OOM is measured against, so the ratio below is
      // the number that predicts a crash.
      add('nodejs.heap.limit', hs.heap_size_limit, 'gauge', 'By');
      if (hs.heap_size_limit > 0) {
        add('nodejs.heap.utilization', hs.used_heap_size / hs.heap_size_limit, 'gauge', '1');
      }
      add('nodejs.heap.external', hs.external_memory, 'gauge', 'By');
      // A Node process is frequently killed for memory that is not in the JS
      // heap at all — Buffers and ArrayBuffers live outside it, so a heap graph
      // alone cannot explain the OOM.
      add('nodejs.heap.malloced', hs.malloced_memory, 'gauge', 'By');
    } catch (e) { /* ignore */ }

    // Per-space is where a leak becomes legible: old_space growing while
    // new_space is stable is a retention problem, not allocation churn.
    try {
      for (const s of v8.getHeapSpaceStatistics()) {
        const labels = { space: s.space_name };
        add('nodejs.heap.space.used', s.space_used_size, 'gauge', 'By', labels);
        add('nodejs.heap.space.total', s.space_size, 'gauge', 'By', labels);
        add('nodejs.heap.space.available', s.space_available_size, 'gauge', 'By', labels);
      }
    } catch (e) { /* ignore */ }

    // --- Process memory ----------------------------------------------------
    try {
      const mu = process.memoryUsage();
      add('nodejs.process.memory.rss', mu.rss, 'gauge', 'By');
      add('nodejs.process.memory.heap_used', mu.heapUsed, 'gauge', 'By');
      add('nodejs.process.memory.external', mu.external, 'gauge', 'By');
      if (mu.arrayBuffers != null) {
        add('nodejs.process.memory.array_buffers', mu.arrayBuffers, 'gauge', 'By');
      }
    } catch (e) { /* ignore */ }

    // --- GC ----------------------------------------------------------------
    // Typed `delta`, not `counter`. GC is observed as events and accumulated
    // since the LAST report, then cleared — so each point is a change over an
    // interval, which is precisely what `delta` means in the data model. Calling
    // it `counter` would claim a cumulative-since-start total and make every
    // rate computed from it wrong.
    //
    // Reported per kind because a scavenge storm and a run of mark-sweeps are
    // different problems: the first is allocation churn, the second is retention
    // pressure.
    for (const kind of Object.keys(this.gcCounts)) {
      add('nodejs.gc.collections', this.gcCounts[kind], 'delta', '{collection}', { kind });
    }
    for (const kind of Object.keys(this.gcDurations)) {
      add('nodejs.gc.duration', this.gcDurations[kind], 'delta', 'ms', { kind });
    }

    // --- Handles and resources ---------------------------------------------
    // getActiveResourcesInfo is the supported way to see what is keeping the loop
    // alive; a steadily climbing count is the signature of leaked sockets, timers
    // or file handles, which no host-level metric reveals.
    try {
      if (typeof process.getActiveResourcesInfo === 'function') {
        const counts = Object.create(null);
        for (const r of process.getActiveResourcesInfo()) {
          counts[r] = (counts[r] || 0) + 1;
        }
        for (const type of Object.keys(counts)) {
          add('nodejs.active_resources', counts[type], 'gauge', '{resource}', { resource_type: type });
        }
      }
    } catch (e) { /* ignore */ }

    // --- Runtime identity --------------------------------------------------
    // An info metric: one series carrying the descriptive facts, rather than
    // multiplying every series above by a version label.
    add('nodejs.runtime.info', 1, 'gauge', '1', {
      version: process.versions.node,
      v8: process.versions.v8,
    });
    add('nodejs.process.uptime', process.uptime(), 'gauge', 's');

    return points;
  }

  /**
   * Collect and ship one batch.
   */
  report() {
    try {
      const transport = this.state.transport;
      if (!transport) return;
      const points = this.collect();
      if (!points.length) return;

      const config = this.state.config || {};
      const line = {
        type: 'metric',
        metrics: points,
      };
      if (config.organizationId) line.organization_id = config.organizationId;
      if (config.projectId) line.project_id = config.projectId;
      // The service label is what ties these numbers to the spans from the same
      // process; without it a runtime metric is unattributable.
      const service = config.service || 'node-app';
      for (const p of points) {
        p.labels = Object.assign({ service }, p.labels || {});
      }

      transport.send(line);

      // Clear the GC accumulators: they were emitted as `delta` points covering
      // the interval just reported, so carrying them forward would count the same
      // collections again on every subsequent report.
      this.gcCounts = Object.create(null);
      this.gcDurations = Object.create(null);
    } catch (e) { /* never let metrics break the app */ }
  }
}

// V8 GC type flags. Numeric on the wire, meaningless in a chart.
function gcKindName(kind) {
  switch (kind) {
    case 1: return 'scavenge';
    case 2: return 'minor_mark_compact';
    case 4: return 'mark_sweep_compact';
    case 8: return 'incremental_marking';
    case 16: return 'weak_callbacks';
    default: return 'other';
  }
}

module.exports = { RuntimeMetrics, DEFAULT_INTERVAL_MS, gcKindName };
