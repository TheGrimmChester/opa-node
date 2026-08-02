'use strict';

const fs = require('fs');
const path = require('path');

function envBool(value, dflt) {
  if (value === undefined || value === null || value === '') return dflt;
  const v = String(value).toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

function appPackageName() {
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    if (pkg && typeof pkg.name === 'string' && pkg.name.length > 0) return pkg.name;
  } catch (e) {
    /* no package.json in cwd: fall through */
  }
  return null;
}

/**
 * Parse "host:port" (e.g. "127.0.0.1:9090" or "opa-agent:9090").
 */
function parseSocketPath(value) {
  const s = String(value);
  const idx = s.lastIndexOf(':');
  if (idx === -1) return { host: s || '127.0.0.1', port: 9090 };
  const host = s.slice(0, idx) || '127.0.0.1';
  const port = parseInt(s.slice(idx + 1), 10);
  return { host, port: Number.isFinite(port) && port > 0 ? port : 9090 };
}

/**
 * Resolve effective configuration. Precedence: options argument > environment > defaults.
 *
 * Env vars:
 *   OPA_ENABLED         (default 1)
 *   OPA_SOCKET_PATH     "host:port" (default "127.0.0.1:9090")
 *   OPA_SERVICE         (default: name from the app's package.json, else "node-app")
 *   OPA_ORGANIZATION_ID
 *   OPA_PROJECT_ID
 *   OPA_SAMPLING_RATE   0..1 (default 1)
 *   OPA_MAX_TRACES_PER_MINUTE  0 = unlimited (default 0)
 *   OPA_RATE_LIMIT_BURST       defaults to max traces/min when unset/0
 *   OPA_RUNTIME_METRICS (default 1) — event loop / heap / GC metrics
 *   OPA_RUNTIME_METRICS_INTERVAL_MS (default 15000, minimum 1000)
 *   OPA_PROFILING
 *   OPA_DEBUG
 *   OPA_REDACT           (default 0) — scrub sensitive tags/SQL literals
 *   OPA_REDACT_KEYS      comma-separated extra keys
 *   OPA_CAPTURE_SQL      (default 1)
 *   OPA_CAPTURE_ARGS     (default 0) — include arg counts / non-literal metadata
 *   OPA_API_HOST / OPA_API_PORT — fleet heartbeat target (default host + :8088)
 */
function resolveConfig(options) {
  const opts = options || {};
  const env = process.env;

  const socketPath = opts.socketPath || env.OPA_SOCKET_PATH || '127.0.0.1:9090';
  const { host, port } = parseSocketPath(socketPath);

  let samplingRate;
  if (opts.samplingRate !== undefined) {
    samplingRate = Number(opts.samplingRate);
  } else if (env.OPA_SAMPLING_RATE !== undefined && env.OPA_SAMPLING_RATE !== '') {
    samplingRate = Number(env.OPA_SAMPLING_RATE);
  } else {
    samplingRate = 1;
  }
  if (!Number.isFinite(samplingRate)) samplingRate = 1;
  samplingRate = Math.min(1, Math.max(0, samplingRate));

  let maxTracesPerMinute = 0;
  if (opts.maxTracesPerMinute !== undefined) {
    maxTracesPerMinute = Number(opts.maxTracesPerMinute);
  } else if (env.OPA_MAX_TRACES_PER_MINUTE) {
    maxTracesPerMinute = Number(env.OPA_MAX_TRACES_PER_MINUTE);
  }
  if (!Number.isFinite(maxTracesPerMinute) || maxTracesPerMinute < 0) {
    maxTracesPerMinute = 0;
  }

  let rateLimitBurst = 0;
  if (opts.rateLimitBurst !== undefined) {
    rateLimitBurst = Number(opts.rateLimitBurst);
  } else if (env.OPA_RATE_LIMIT_BURST) {
    rateLimitBurst = Number(env.OPA_RATE_LIMIT_BURST);
  }
  if (!Number.isFinite(rateLimitBurst) || rateLimitBurst < 0) {
    rateLimitBurst = 0;
  }

  // Runtime metrics are cheap (a few reads per interval) and answer questions
  // nothing outside the process can, so they default ON. The floor on the
  // interval stops a misconfiguration turning the reporter into the load.
  let runtimeMetricsIntervalMs;
  if (opts.runtimeMetricsIntervalMs !== undefined) {
    runtimeMetricsIntervalMs = Number(opts.runtimeMetricsIntervalMs);
  } else if (env.OPA_RUNTIME_METRICS_INTERVAL_MS) {
    runtimeMetricsIntervalMs = Number(env.OPA_RUNTIME_METRICS_INTERVAL_MS);
  } else {
    runtimeMetricsIntervalMs = 15000;
  }
  if (!Number.isFinite(runtimeMetricsIntervalMs) || runtimeMetricsIntervalMs < 1000) {
    runtimeMetricsIntervalMs = 15000;
  }

  let redactKeys = [];
  if (Array.isArray(opts.redactKeys)) {
    redactKeys = opts.redactKeys;
  } else if (env.OPA_REDACT_KEYS) {
    redactKeys = String(env.OPA_REDACT_KEYS).split(',').map((s) => s.trim()).filter(Boolean);
  }

  const apiHost = opts.apiHost || env.OPA_API_HOST || host;
  let apiPort = opts.apiPort !== undefined ? Number(opts.apiPort) : (env.OPA_API_PORT ? Number(env.OPA_API_PORT) : 8088);
  if (!Number.isFinite(apiPort) || apiPort <= 0) apiPort = 8088;

  const { detectFramework } = require('./framework');

  return {
    enabled: opts.enabled !== undefined ? !!opts.enabled : envBool(env.OPA_ENABLED, true),
    socketPath,
    host,
    port,
    apiHost,
    apiPort,
    service: opts.service || env.OPA_SERVICE || appPackageName() || 'node-app',
    organizationId: opts.organizationId || env.OPA_ORGANIZATION_ID || '',
    projectId: opts.projectId || env.OPA_PROJECT_ID || '',
    samplingRate,
    maxTracesPerMinute,
    rateLimitBurst,
    runtimeMetrics: opts.runtimeMetrics !== undefined
      ? !!opts.runtimeMetrics
      : envBool(env.OPA_RUNTIME_METRICS, true),
    runtimeMetricsIntervalMs,
    profiling: opts.profiling !== undefined
      ? !!opts.profiling
      : envBool(env.OPA_PROFILING, false),
    profilingIntervalMs: (function () {
      let v = opts.profilingIntervalMs !== undefined
        ? Number(opts.profilingIntervalMs)
        : (env.OPA_PROFILING_INTERVAL_MS ? Number(env.OPA_PROFILING_INTERVAL_MS) : 100);
      if (!Number.isFinite(v) || v < 10) v = 100;
      return v;
    })(),
    redact: opts.redact !== undefined ? !!opts.redact : envBool(env.OPA_REDACT, false),
    redactKeys,
    captureSql: opts.captureSql !== undefined ? !!opts.captureSql : envBool(env.OPA_CAPTURE_SQL, true),
    captureArgs: opts.captureArgs !== undefined ? !!opts.captureArgs : envBool(env.OPA_CAPTURE_ARGS, false),
    framework: opts.framework || env.OPA_FRAMEWORK || detectFramework(),
    debug: opts.debug !== undefined ? !!opts.debug : envBool(env.OPA_DEBUG, false),
    // Serverless
    serverlessFlushMs: (function () {
      let v = opts.serverlessFlushMs !== undefined
        ? Number(opts.serverlessFlushMs)
        : (env.OPA_SERVERLESS_FLUSH_MS ? Number(env.OPA_SERVERLESS_FLUSH_MS) : 400);
      if (!Number.isFinite(v) || v < 50) v = 400;
      return v;
    })(),
    httpIngestURL: opts.httpIngestURL || env.OPA_HTTP_INGEST_URL || ''
  };
}

module.exports = { resolveConfig, parseSocketPath, envBool };
