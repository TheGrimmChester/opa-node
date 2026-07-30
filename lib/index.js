'use strict';

const { resolveConfig } = require('./config');
const Transport = require('./transport');
const api = require('./api');
const httpServer = require('./instrument/httpServer');
const httpClient = require('./instrument/httpClient');
const fetchClient = require('./instrument/fetchClient');
const db = require('./instrument/db');
const logShipper = require('./log');
const { RuntimeMetrics } = require('./runtimeMetrics');
const { Metrics } = require('./metrics');
const { Errors } = require('./errors');
const { SamplingProfiler } = require('./samplingProfiler');
const { Fleet } = require('./fleet');
const queue = require('./instrument/queue');
const mongo = require('./instrument/mongo');
const xcut = require('./instrument/xcut');
const { createRedactor } = require('./redact');

// Shared mutable agent state; instrumentation patches read config/transport
// through this object so shutdown()/restart works without re-patching.
const state = { config: null, transport: null, started: false, runtimeMetrics: null, metrics: null, errors: null, samplingProfiler: null, fleet: null, redactor: null };

/**
 * Start the OPA agent. Idempotent: subsequent calls are no-ops.
 * @param {object} [options] overrides (see lib/config.js) — options > env.
 */
function start(options) {
  if (state.started) return module.exports;
  try {
    const config = resolveConfig(options);
    state.config = config;
    if (!config.enabled) {
      state.started = true;
      if (config.debug) safeLog('[opa-node] disabled (OPA_ENABLED=0)');
      return module.exports;
    }
    state.transport = new Transport(config);
    httpServer.patch(state);
    httpClient.patch(state);
    // Global fetch() (undici) is the default client on Node >= 18 and bypasses
    // http.request entirely, so it needs its own patch or those calls are
    // invisible to tracing.
    fetchClient.patch(state);
    // pg / mysql2 / ioredis — patched only when the app has them installed.
    db.patch(state);
    mongo.patch(state);
    state.redactor = createRedactor(config);
    // Event-loop lag, heap spaces and GC: none of these are visible to a host
    // collector, and they are what explain a Node service whose spans look fine
    // while requests queue.
    if (config.runtimeMetrics) {
      state.runtimeMetrics = new RuntimeMetrics(state, config.runtimeMetricsIntervalMs);
      state.runtimeMetrics.start();
    }
    state.metrics = new Metrics(state);
    // Wave 10-2: uncaughtException / unhandledRejection + captureException API.
    state.errors = new Errors(state);
    state.errors.installHooks();
    // Wave 11-5: optional CPU sampling profiler (OPA_PROFILING=1).
    if (config.profiling) {
      state.samplingProfiler = new SamplingProfiler(state, {
        intervalMs: config.profilingIntervalMs || 100
      });
      state.samplingProfiler.start();
    }
    // Wave 13-3: fleet heartbeat / remote config (kill-switch, sampling).
    state.fleet = new Fleet(state, {
      onConfig: (remote) => {
        if (!remote || !state.config) return;
        if (typeof remote.sampling_rate === 'number') {
          state.config.samplingRate = Math.min(1, Math.max(0, remote.sampling_rate));
        }
        if (typeof remote.capture_sql === 'boolean') state.config.captureSql = remote.capture_sql;
        if (typeof remote.capture_args === 'boolean') state.config.captureArgs = remote.capture_args;
        if (Array.isArray(remote.redaction_rules) && remote.redaction_rules.length) {
          state.config.redact = true;
          state.config.redactKeys = remote.redaction_rules;
          state.redactor = createRedactor(state.config);
        }
      }
    });
    state.fleet.start();
    state.started = true;
    if (config.debug) {
      safeLog('[opa-node] started; service=' + config.service + ' framework=' + config.framework + ' -> ' + config.host + ':' + config.port);
    }
  } catch (e) {
    safeLog('[opa-node] start failed: ' + (e && e.message));
  }
  return module.exports;
}

/**
 * Flush pending spans and close the transport. Resolves always.
 */
function shutdown() {
  // Stop the reporter BEFORE the transport: a report firing into a closed
  // transport is a wasted collection, and the timer would otherwise keep an
  // interval alive against a null transport.
  if (state.runtimeMetrics) {
    state.runtimeMetrics.stop();
    state.runtimeMetrics = null;
  }
  if (state.metrics) {
    state.metrics.stop();
    state.metrics = null;
  }
  if (state.samplingProfiler) {
    state.samplingProfiler.stop();
    state.samplingProfiler = null;
  }
  if (state.fleet) {
    state.fleet.stop();
    state.fleet = null;
  }
  state.errors = null;
  const transport = state.transport;
  state.transport = null;
  state.started = false;
  return transport ? transport.shutdown() : Promise.resolve();
}

function safeLog(msg) {
  try {
    if (process.env.OPA_DEBUG || (state.config && state.config.debug)) console.error(msg);
  } catch (e) { /* ignore */ }
}

// Structured logging: shipped on the same socket as spans, correlated to the
// active request when there is one.
const log = (level, message, fields) => logShipper.log(state, level, message, fields);

function metricsApi() {
  return state.metrics;
}

module.exports = {
  start,
  shutdown,
  span: api.span,
  addTags: api.addTags,
  recordSql: api.recordSql,
  recordRedis: api.recordRedis,
  counter: (name, value, labels) => { const m = metricsApi(); if (m) m.counter(name, value, labels); },
  gauge: (name, value, labels) => { const m = metricsApi(); if (m) m.gauge(name, value, labels); },
  histogram: (name, value, labels) => { const m = metricsApi(); if (m) m.histogram(name, value, labels); },
  timer: (name, valueMs, labels) => { const m = metricsApi(); if (m) m.timer(name, valueMs, labels); },
  time: (name, labels, fn) => {
    const m = metricsApi();
    if (!m) return typeof fn === 'function' ? fn() : undefined;
    return m.time(name, labels, fn);
  },
  log,
  logInfo: (message, fields) => log('INFO', message, fields),
  logWarn: (message, fields) => log('WARN', message, fields),
  logError: (message, fields) => log('ERROR', message, fields),
  captureException: (err, opts) => { if (state.errors) state.errors.captureException(err, opts); },
  captureError: (message, opts) => { if (state.errors) state.errors.captureError(message, opts); },
  wrapQueueProcessor: (opts, handler) => queue.wrapProcessor(state, opts, handler),
  queueTags: queue.queueTags,
  queueSpanName: queue.queueSpanName,
  noteGraphql: xcut.noteGraphql,
  noteGrpc: xcut.noteGrpc,
  noteCli: xcut.noteCli,
  graphqlSpanName: xcut.graphqlSpanName,
  grpcSpanName: xcut.grpcSpanName,
  cliTransactionName: xcut.cliTransactionName,
  ioTags: xcut.ioTags,
  _state: state // internal, for tests/diagnostics
};
