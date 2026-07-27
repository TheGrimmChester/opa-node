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
 *   OPA_DEBUG
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

  return {
    enabled: opts.enabled !== undefined ? !!opts.enabled : envBool(env.OPA_ENABLED, true),
    socketPath,
    host,
    port,
    service: opts.service || env.OPA_SERVICE || appPackageName() || 'node-app',
    organizationId: opts.organizationId || env.OPA_ORGANIZATION_ID || '',
    projectId: opts.projectId || env.OPA_PROJECT_ID || '',
    samplingRate,
    debug: opts.debug !== undefined ? !!opts.debug : envBool(env.OPA_DEBUG, false)
  };
}

module.exports = { resolveConfig, parseSocketPath, envBool };
