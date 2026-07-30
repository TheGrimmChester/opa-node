'use strict';

/**
 * Wave 8-2 application metrics API.
 *
 * Counter / gauge / histogram / timer with tags. Client-side pre-aggregation
 * batches points into type:"metric" ND-JSON messages on the same transport as
 * spans, so a busy process does not open a second channel to the agent.
 */

const FLUSH_MS = 10000;

function Metrics(state) {
  this._state = state;
  this._buf = new Map(); // key -> {point fields, _agg}
  this._timer = null;
}

Metrics.prototype._key = function (name, labels) {
  const parts = [name];
  const keys = Object.keys(labels || {}).sort();
  for (let i = 0; i < keys.length; i++) {
    parts.push(keys[i] + '=' + labels[keys[i]]);
  }
  return parts.join('\x1f');
};

Metrics.prototype._ensureFlush = function () {
  if (this._timer || !this._state) return;
  const self = this;
  this._timer = setInterval(function () { self.flush(); }, FLUSH_MS);
  if (this._timer.unref) this._timer.unref();
};

Metrics.prototype._accumulate = function (name, type, value, labels, extra) {
  try {
    if (!this._state || !this._state.started || !this._state.config || !this._state.config.enabled) {
      return;
    }
    labels = labels || {};
    const key = this._key(name, labels) + '\x1f' + type;
    let e = this._buf.get(key);
    if (!e) {
      e = {
        name: String(name),
        type: type,
        labels: Object.assign({}, labels),
        value: 0,
        count: 0,
        sum: 0,
        _n: 0
      };
      this._buf.set(key, e);
    }
    if (type === 'gauge') {
      e.value = Number(value) || 0;
    } else if (type === 'counter') {
      e.value += Number(value) || 0;
    } else {
      // histogram / timer
      const v = Number(value) || 0;
      e.count += 1;
      e.sum += v;
      e.value = e.sum;
      if (!e.histogram) {
        e.histogram = { kind: 'explicit', explicit_bounds: [], bucket_counts: [] };
      }
      // Keep a coarse max bound for the batch.
      const bounds = e.histogram.explicit_bounds;
      if (bounds.length === 0 || v > bounds[bounds.length - 1]) {
        bounds.push(v);
        e.histogram.bucket_counts.push(1);
      } else {
        e.histogram.bucket_counts[e.histogram.bucket_counts.length - 1] =
          (e.histogram.bucket_counts[e.histogram.bucket_counts.length - 1] || 0) + 1;
      }
    }
    e._n++;
    this._ensureFlush();
  } catch (err) { /* never break the app */ }
};

Metrics.prototype.counter = function (name, value, labels) {
  this._accumulate(name, 'counter', value == null ? 1 : value, labels);
};

Metrics.prototype.gauge = function (name, value, labels) {
  this._accumulate(name, 'gauge', value, labels);
};

Metrics.prototype.histogram = function (name, value, labels) {
  this._accumulate(name, 'histogram', value, labels);
};

Metrics.prototype.timer = function (name, valueMs, labels) {
  this._accumulate(name, 'histogram', valueMs, labels);
};

/** Time a sync or promise-returning function; records duration as a histogram. */
Metrics.prototype.time = function (name, labels, fn) {
  const self = this;
  const start = process.hrtime.bigint();
  const finish = function () {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    self.timer(name, ms, labels);
  };
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      return out.then(
        function (v) { finish(); return v; },
        function (err) { finish(); throw err; }
      );
    }
    finish();
    return out;
  } catch (err) {
    finish();
    throw err;
  }
};

Metrics.prototype.flush = function () {
  try {
    if (!this._state || !this._state.transport || this._buf.size === 0) return;
    const metrics = [];
    this._buf.forEach(function (e) {
      const p = {
        name: e.name,
        type: e.type,
        labels: e.labels,
        value: e.value
      };
      if (e.type === 'histogram') {
        p.count = e.count;
        p.sum = e.sum;
        if (e.histogram) p.histogram = e.histogram;
      }
      metrics.push(p);
    });
    this._buf.clear();
    const cfg = this._state.config || {};
    this._state.transport.send({
      type: 'metric',
      organization_id: cfg.organizationId || cfg.organization_id || '',
      project_id: cfg.projectId || cfg.project_id || '',
      metrics: metrics
    });
  } catch (err) { /* ignore */ }
};

Metrics.prototype.stop = function () {
  if (this._timer) {
    clearInterval(this._timer);
    this._timer = null;
  }
  this.flush();
};

module.exports = { Metrics };
