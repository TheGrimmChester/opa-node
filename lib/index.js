'use strict';

const { resolveConfig } = require('./config');
const Transport = require('./transport');
const api = require('./api');
const httpServer = require('./instrument/httpServer');
const httpClient = require('./instrument/httpClient');
const fetchClient = require('./instrument/fetchClient');

// Shared mutable agent state; instrumentation patches read config/transport
// through this object so shutdown()/restart works without re-patching.
const state = { config: null, transport: null, started: false };

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
    state.started = true;
    if (config.debug) {
      safeLog('[opa-node] started; service=' + config.service + ' -> ' + config.host + ':' + config.port);
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

module.exports = {
  start,
  shutdown,
  span: api.span,
  addTags: api.addTags,
  recordSql: api.recordSql,
  recordRedis: api.recordRedis,
  _state: state // internal, for tests/diagnostics
};
