'use strict';

/**
 * Serverless: AWS Lambda / FaaS wrapper with freeze-safe flush.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const context = require('./context');
const ids = require('./ids');
const api = require('./api');

let coldStart = true;
const initStartedAt = Date.now();
let initDurationMs = 0;

function markWarm() {
  if (coldStart) initDurationMs = Date.now() - initStartedAt;
}

function extractTraceparent(event) {
  if (!event || typeof event !== 'object') return null;
  const headers = event.headers || event.multiValueHeaders || {};
  const lower = {};
  Object.keys(headers).forEach((k) => {
    lower[String(k).toLowerCase()] = Array.isArray(headers[k]) ? headers[k][0] : headers[k];
  });
  if (lower.traceparent) return lower.traceparent;
  const rec = event.Records && event.Records[0];
  if (rec && rec.messageAttributes) {
    const tp = rec.messageAttributes.traceparent || rec.messageAttributes.Traceparent;
    if (tp && (tp.stringValue || tp.Value)) return tp.stringValue || tp.Value;
  }
  if (event.detail && event.detail.traceparent) return event.detail.traceparent;
  if (event.detail && event.detail._opa && event.detail._opa.traceparent) {
    return event.detail._opa.traceparent;
  }
  return null;
}

function eventTrigger(event) {
  if (!event) return 'unknown';
  // Empty http {} is truthy in JS objects-by-reference, but prefer key checks.
  if (event.requestContext && (event.requestContext.http != null || event.requestContext.routeKey || event.requestContext.httpMethod)) return 'http';
  if (event.Records && event.Records[0] && event.Records[0].eventSource === 'aws:sqs') return 'sqs';
  if (event.Records && event.Records[0] && event.Records[0].EventSource === 'aws:sns') return 'sns';
  if (event.source && String(event.source).indexOf('aws.') === 0) return 'eventbridge';
  if (event.Records && event.Records[0] && event.Records[0].s3) return 's3';
  return 'other';
}

function httpFlush(urlStr, lines, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const u = new URL(urlStr);
      const lib = u.protocol === 'https:' ? https : http;
      const body = lines.join('');
      const req = lib.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + (u.search || ''),
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-ndjson',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: timeoutMs
      }, (res) => { res.resume(); done(res.statusCode >= 200 && res.statusCode < 300); });
      req.on('error', () => done(false));
      req.on('timeout', () => { try { req.destroy(); } catch (_) {} done(false); });
      req.write(body);
      req.end();
    } catch (_) { done(false); }
  });
}

async function flushBeforeFreeze(state, deadlineMs) {
  const transport = state && state.transport;
  if (!transport) return;
  const httpURL = (state.config && state.config.httpIngestURL) || process.env.OPA_HTTP_INGEST_URL || '';
  if (httpURL && typeof transport.drainLines === 'function') {
    const lines = transport.drainLines();
    if (lines.length) {
      const base = httpURL.replace(/\/$/, '');
      await httpFlush(base.indexOf('/v1/') >= 0 ? base : base + '/v1/ndjson', lines, deadlineMs);
    }
    return;
  }
  if (typeof transport.flushSync === 'function') {
    await transport.flushSync(deadlineMs);
  } else if (typeof transport.flush === 'function') {
    transport.flush();
  }
}

function wrapHandler(state, handler) {
  markWarm();
  return async function opaWrappedHandler(event, contextArg) {
    const isCold = coldStart;
    coldStart = false;
    const started = Date.now();
    const fn = (contextArg && (contextArg.functionName || contextArg.function_name))
      || process.env.AWS_LAMBDA_FUNCTION_NAME || 'lambda';
    const mem = Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE || 0);
    const trigger = eventTrigger(event);
    const tpRaw = extractTraceparent(event);
    const tp = tpRaw ? ids.parseTraceparent(tpRaw) : null;

    const ctx = context.createContext({
      traceId: tp ? tp.traceId : ids.newTraceId(),
      spanId: ids.newSpanId(),
      parentId: tp ? tp.parentId : null,
      w3cTraceparent: tpRaw || null
    });

    let status = 'ok';
    try {
      return await context.run(ctx, async () => {
        try {
          api.addTags({
            'faas.name': fn,
            'faas.trigger': trigger,
            'faas.coldstart': isCold,
            'cloud.provider': 'aws',
            'cloud.region': process.env.AWS_REGION || '',
            faas_name: fn,
            faas_trigger: trigger,
            cold_start: isCold
          });
        } catch (_) { /* ignore */ }
        return handler(event, contextArg);
      });
    } catch (e) {
      status = 'error';
      throw e;
    } finally {
      const durationMs = Date.now() - started;
      const spanObj = {
        type: 'span',
        trace_id: ctx.traceId,
        span_id: ctx.spanId,
        parent_id: ctx.parentId,
        name: `faas ${fn}`,
        service: (state.config && state.config.service) || fn,
        status,
        duration_ms: durationMs,
        kind: (trigger === 'sqs' || trigger === 'sns' || trigger === 'eventbridge') ? 'consumer' : 'server',
        tags: Object.assign({}, ctx.tags || {}, {
          'faas.name': fn,
          'faas.trigger': trigger,
          'faas.coldstart': isCold
        }),
        organization_id: state.config && state.config.organizationId,
        project_id: state.config && state.config.projectId,
        w3c_traceparent: ctx.w3cTraceparent
      };
      const faasMsg = {
        type: 'faas',
        function_name: fn,
        service: spanObj.service,
        cold_start: isCold,
        duration_ms: durationMs,
        init_duration_ms: isCold ? initDurationMs : 0,
        billed_duration_ms: Number(process.env.OPA_FAAS_BILLED_MS) || durationMs,
        memory_mb: mem,
        max_memory_used_mb: Number(process.env.OPA_FAAS_MAX_MEMORY_USED_MB) || 0,
        trigger,
        trace_id: ctx.traceId,
        organization_id: spanObj.organization_id,
        project_id: spanObj.project_id
      };
      try {
        if (state.transport) {
          state.transport.send(spanObj);
          state.transport.send(faasMsg);
        }
      } catch (_) { /* ignore */ }
      const deadlineMs = Number((state.config && state.config.serverlessFlushMs) || 400);
      await flushBeforeFreeze(state, deadlineMs);
    }
  };
}

module.exports = {
  wrapHandler,
  extractTraceparent,
  eventTrigger,
  flushBeforeFreeze,
  isColdStart: () => coldStart,
  initDurationMs: () => initDurationMs
};
