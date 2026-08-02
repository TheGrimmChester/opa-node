'use strict';

const context = require('../context');
const ids = require('../ids');
const { shared: rateLimiter } = require('../rateLimit');

let patched = false;

function debug(state, e) {
  if (state && state.config && state.config.debug) {
    try { console.error('[opa-node httpServer]', e && e.stack ? e.stack : e); } catch (err) { /* ignore */ }
  }
}

/**
 * Patch http.Server.prototype.emit (and https.Server) for 'request' events.
 * Works for plain node, express, fastify and anything else built on http.Server.
 *
 * @param {{config: object, transport: object}} state shared agent state
 */
function patch(state) {
  if (patched) return;
  patched = true;
  const http = require('http');
  wrapServerEmit(http.Server.prototype, state);
  try {
    const https = require('https');
    if (https.Server && https.Server.prototype.emit !== http.Server.prototype.emit) {
      wrapServerEmit(https.Server.prototype, state);
    }
  } catch (e) {
    debug(state, e);
  }
}

function wrapServerEmit(proto, state) {
  const origEmit = proto.emit;
  proto.emit = function emit(event) {
    if (event !== 'request') return origEmit.apply(this, arguments);
    try {
      return handleRequest(this, origEmit, arguments, state);
    } catch (e) {
      debug(state, e);
      return origEmit.apply(this, arguments);
    }
  };
}

function handleRequest(server, origEmit, args, state) {
  const config = state.config;
  if (!config || !config.enabled) return origEmit.apply(server, args);

  // Per-request sampling decision at span creation.
  if (config.samplingRate < 1 && Math.random() >= config.samplingRate) {
    return origEmit.apply(server, args);
  }

  const req = args[1];
  const res = args[2];
  if (!req || !res) return origEmit.apply(server, args);

  // Rate limit before we attach listeners / run context — that is the overhead
  // win. Keyed by method+path (route template is only known at finish).
  const { pathname } = splitUrl(req.url);
  const method = req.method || 'GET';
  const txnName = method + ' ' + pathname;
  const decision = rateLimiter.allow(
    txnName,
    config.maxTracesPerMinute,
    config.rateLimitBurst
  );
  if (!decision.allowed) {
    return origEmit.apply(server, args);
  }

  let sampleWeight = 1;
  if (config.samplingRate > 0 && config.samplingRate < 1) {
    sampleWeight = 1 / config.samplingRate;
  }
  sampleWeight = sampleWeight * (1 + (decision.weightBonus || 0));

  const tp = ids.parseTraceparent(req.headers && req.headers['traceparent']);
  const ctx = context.createContext({
    traceId: tp ? tp.traceId : ids.newTraceId(),
    spanId: ids.newSpanId(),
    parentId: tp ? tp.parentId : null,
    w3cTraceparent: tp ? ids.buildTraceparent(tp.traceId, tp.parentId) : null
  });
  ctx.sampleWeight = sampleWeight;

  const startTs = Date.now();
  const startHr = process.hrtime.bigint();
  const startCpu = safeCpuUsage();

  let sent = false;
  const finalize = (finished) => {
    if (sent) return;
    sent = true;
    try {
      const spanObj = buildSpan(state, ctx, req, res, {
        startTs,
        startHr,
        startCpu,
        finished
      });
      if (state.transport) state.transport.send(spanObj);
    } catch (e) {
      debug(state, e);
    }
  };

  res.on('finish', () => finalize(true));
  res.on('close', () => finalize(res.writableFinished === true));

  return context.run(ctx, () => origEmit.apply(server, args));
}

function safeCpuUsage(previous) {
  try {
    return previous ? process.cpuUsage(previous) : process.cpuUsage();
  } catch (e) {
    return null;
  }
}

function splitUrl(rawUrl) {
  const url = typeof rawUrl === 'string' && rawUrl.length > 0 ? rawUrl : '/';
  const qi = url.indexOf('?');
  if (qi === -1) return { pathname: url, queryString: '' };
  return { pathname: url.slice(0, qi), queryString: url.slice(qi + 1) };
}

/**
 * The framework's route template for this request, or null.
 *
 * Express exposes `req.route.path` ('/:id') and, for a mounted Router, the
 * mount prefix in `req.baseUrl` ('/users') — joined they give '/users/:id'.
 * Fastify exposes the full template on `req.routeOptions.url` (v4+) or the
 * legacy `req.routerPath`. Read defensively: these are getters on
 * framework-owned objects and must never break span emission.
 */
function routeOf(req) {
  try {
    const fastify = (req.routeOptions && req.routeOptions.url) || req.routerPath;
    if (typeof fastify === 'string' && fastify.length > 0) return fastify;

    const path = req.route && req.route.path;
    if (typeof path !== 'string' || path.length === 0) return null;
    const base = typeof req.baseUrl === 'string' ? req.baseUrl : '';
    if (path === '/') return base || '/';
    const joined = base + path;
    return joined.length > 0 ? joined : null;
  } catch (e) {
    return null;
  }
}

function hostWithoutPort(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return 'localhost';
  // IPv6 literal like [::1]:8080
  if (hostHeader[0] === '[') {
    const end = hostHeader.indexOf(']');
    return end === -1 ? hostHeader : hostHeader.slice(0, end + 1);
  }
  const idx = hostHeader.indexOf(':');
  return idx === -1 ? hostHeader : hostHeader.slice(0, idx);
}

/** Correlate Perf Lab / load-runner traffic onto spans (Perf lab / JMeter). */
function loadRunIdFromRequest(req) {
  const h = (req && req.headers) || {};
  const direct = h['x-opa-load-run-id'];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const bag = typeof h.baggage === 'string' ? h.baggage : '';
  if (!bag) return '';
  const parts = bag.split(',');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (p.indexOf('opa.load_run_id=') === 0) return p.slice('opa.load_run_id='.length).trim();
    if (p.indexOf('load_run_id=') === 0) return p.slice('load_run_id='.length).trim();
  }
  return '';
}

function buildSpan(state, ctx, req, res, timing) {
  const config = state.config;
  const endTs = Date.now();
  const durationMs = Number(process.hrtime.bigint() - timing.startHr) / 1e6;

  let cpuMs = 0;
  if (timing.startCpu) {
    const delta = safeCpuUsage(timing.startCpu);
    if (delta) cpuMs = (delta.user + delta.system) / 1000;
  }

  const { pathname, queryString } = splitUrl(req.url);
  const method = req.method || 'GET';
  // Group by route template when the framework exposes one, so /users/42 and
  // /users/43 aggregate as "GET /users/:id" instead of splintering into one
  // endpoint per id. Falls back to the concrete path.
  const routeTemplate = routeOf(req);
  const scheme = req.socket && req.socket.encrypted ? 'https' : 'http';
  const statusCode = res.statusCode || 0;
  const status = timing.finished && statusCode < 500 ? 'ok' : 'error';

  const tags = {};
  if (config.organizationId) tags.organization_id = config.organizationId;
  if (config.projectId) tags.project_id = config.projectId;
  Object.assign(tags, ctx.tags);
  tags.http_request = {
    scheme,
    host: hostWithoutPort(req.headers && req.headers.host),
    uri: pathname,
    query_string: queryString,
    method,
    status_code: statusCode
  };
  const loadRunId = loadRunIdFromRequest(req);
  if (loadRunId) {
    tags.load_run_id = loadRunId;
    // Also mirror into request_headers so Agent ingest can recover the id
    // even if an older pipeline only reads http.request_headers.
    tags.request_headers = {
      'X-OPA-Load-Run-Id': loadRunId,
      baggage: 'load_run_id=' + loadRunId
    };
  }

  const spanObj = {
    type: 'span',
    trace_id: ctx.traceId,
    span_id: ctx.spanId,
    parent_id: ctx.parentId || null,
    service: config.service,
    name: method + ' ' + (routeTemplate || pathname),
    url_scheme: scheme,
    url_host: '', // inbound requests: MUST be empty
    url_path: pathname,
    start_ts: timing.startTs,
    end_ts: endTs,
    duration_ms: durationMs,
    cpu_ms: cpuMs,
    status,
    http: ctx.ops.http,
    sql: ctx.ops.sql,
    redis: ctx.ops.redis,
    tags,
    language: 'node',
    language_version: process.versions.node
  };

  // Optional flat call tree: manual span() nodes become depth-1 children of a
  // single root node representing the handler.
  if (ctx.stack.length > 0) {
    const rootId = 'c0';
    const root = {
      call_id: rootId,
      function: spanObj.name,
      class: '',
      file: '',
      line: 0,
      duration_ms: durationMs,
      cpu_ms: cpuMs,
      memory_delta: 0,
      parent_id: '',
      depth: 0
    };
    spanObj.stack = [root].concat(
      ctx.stack.map((node) => Object.assign({}, node, { parent_id: rootId, depth: 1 }))
    );
    const { annotateStack } = require('../pathHash');
    spanObj.stack = annotateStack(spanObj.stack);
  }

  if (ctx.w3cTraceparent) spanObj.w3c_traceparent = ctx.w3cTraceparent;
  if (ctx.sampleWeight && ctx.sampleWeight !== 1) {
    spanObj.sample_weight = ctx.sampleWeight;
  }

  return spanObj;
}

module.exports = { patch };
