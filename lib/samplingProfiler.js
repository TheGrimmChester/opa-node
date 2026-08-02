'use strict';

/**
 * Wave 11-5: timer-interrupt style CPU sampling profiler for Node.
 *
 * Periodically samples the async stack / call stack via Error.stack and ships
 * type:"profile" ND-JSON batches. Lower overhead than instrumenting every call.
 */

const inspector = require('inspector');

function SamplingProfiler(state, opts) {
  this._state = state;
  this._opts = opts || {};
  this._intervalMs = this._opts.intervalMs || 100;
  this._durationMs = this._opts.durationMs || 0; // 0 = continuous
  this._timer = null;
  this._session = null;
  this._buf = new Map(); // stackKey -> { stack, value }
  this._flushTimer = null;
}

SamplingProfiler.prototype.start = function () {
  if (this._timer) return;
  const self = this;
  // Prefer inspector CPU profiler when available; fall back to Error.stack ticks.
  try {
    this._session = new inspector.Session();
    this._session.connect();
    this._session.post('Profiler.enable');
    this._session.post('Profiler.start');
    this._usingInspector = true;
  } catch (e) {
    this._usingInspector = false;
  }
  this._timer = setInterval(function () { self._tick(); }, this._intervalMs);
  if (this._timer.unref) this._timer.unref();
  this._flushTimer = setInterval(function () { self.flush(); }, 5000);
  if (this._flushTimer.unref) this._flushTimer.unref();
  if (this._durationMs > 0) {
    const t = setTimeout(function () { self.stop(); }, this._durationMs);
    if (t.unref) t.unref();
  }
};

SamplingProfiler.prototype._tick = function () {
  if (this._usingInspector) return; // inspector collects; we harvest on flush
  try {
    const err = new Error();
    Error.captureStackTrace(err, SamplingProfiler.prototype._tick);
    const frames = String(err.stack || '').split('\n').slice(1).map(function (line) {
      const m = line.match(/at (?:(.+?) \()?(.+?):(\d+):\d+\)?/);
      if (!m) return null;
      return (m[1] || '<anonymous>') + ' ' + m[2] + ':' + m[3];
    }).filter(Boolean);
    if (frames.length === 0) return;
    const key = frames.join('|');
    const cur = this._buf.get(key) || { stack: frames, value: 0 };
    cur.value++;
    this._buf.set(key, cur);
  } catch (e) { /* ignore */ }
};

SamplingProfiler.prototype.flush = function () {
  const self = this;
  if (this._usingInspector && this._session) {
    try {
      this._session.post('Profiler.stop', function (err, { profile }) {
        if (err || !profile) return;
        self._ingestInspectorProfile(profile);
      });
      this._session.post('Profiler.start');
    } catch (e) { /* ignore */ }
    return;
  }
  if (this._buf.size === 0) return;
  if (!this._state || !this._state.transport) {
    this._buf.clear();
    return;
  }
  const cfg = this._state.config || {};
  const samples = [];
  this._buf.forEach(function (v) {
    samples.push({ stack: v.stack, value: v.value });
  });
  this._buf.clear();
  this._state.transport.send({
    type: 'profile',
    profile_type: 'cpu',
    language: 'node',
    service: cfg.service || 'node',
    organization_id: cfg.organizationId || cfg.organization_id || '',
    project_id: cfg.projectId || cfg.project_id || '',
    timestamp_ms: Date.now(),
    samples: samples
  });
};

SamplingProfiler.prototype._ingestInspectorProfile = function (profile) {
  if (!this._state || !this._state.transport || !profile || !profile.nodes) return;
  const nodes = profile.nodes;
  const byId = {};
  nodes.forEach(function (n) { byId[n.id] = n; });
  const samples = [];
  (profile.samples || []).forEach(function (id) {
    const stack = [];
    let cur = byId[id];
    let guard = 0;
    while (cur && guard++ < 64) {
      const fn = (cur.callFrame && (cur.callFrame.functionName || cur.callFrame.url)) || 'unknown';
      stack.push(fn);
      cur = cur.parent ? byId[cur.parent] : null;
    }
    if (stack.length) samples.push({ stack: stack, value: 1 });
  });
  // Aggregate identical stacks
  const agg = new Map();
  samples.forEach(function (s) {
    const k = s.stack.join('|');
    const cur = agg.get(k) || { stack: s.stack, value: 0 };
    cur.value++;
    agg.set(k, cur);
  });
  const out = [];
  agg.forEach(function (v) { out.push(v); });
  if (out.length === 0) return;
  const cfg = this._state.config || {};
  this._state.transport.send({
    type: 'profile',
    profile_type: 'cpu',
    language: 'node',
    service: cfg.service || 'node',
    organization_id: cfg.organizationId || cfg.organization_id || '',
    project_id: cfg.projectId || cfg.project_id || '',
    timestamp_ms: Date.now(),
    samples: out.slice(0, 500)
  });
};

SamplingProfiler.prototype.stop = function () {
  if (this._timer) { clearInterval(this._timer); this._timer = null; }
  if (this._flushTimer) { clearInterval(this._flushTimer); this._flushTimer = null; }
  this.flush();
  if (this._session) {
    try { this._session.post('Profiler.disable'); this._session.disconnect(); } catch (e) {}
    this._session = null;
  }
};

module.exports = { SamplingProfiler };
