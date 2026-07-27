'use strict';

const { URL } = require('url');
const context = require('../context');
const ids = require('../ids');

let patched = false;

function debug(state, e) {
  if (state && state.config && state.config.debug) {
    try { console.error('[opa-node httpClient]', e && e.stack ? e.stack : e); } catch (err) { /* ignore */ }
  }
}

/**
 * Patch http.request / http.get / https.request / https.get:
 * - inject a W3C traceparent header carrying the active trace/span ids,
 * - time the request and push {url, method, uri, status_code, duration}
 *   into the active span context's ops.http.
 * With no active span the original call runs untouched.
 */
function patch(state) {
  if (patched) return;
  patched = true;
  const http = require('http');
  const https = require('https');
  wrapModule(http, 'http:', state);
  wrapModule(https, 'https:', state);
}

function wrapModule(mod, defaultProtocol, state) {
  const origRequest = mod.request;
  const origGet = mod.get;

  mod.request = function request() {
    return wrappedCall(origRequest, mod, defaultProtocol, arguments, state);
  };
  mod.get = function get() {
    return wrappedCall(origGet, mod, defaultProtocol, arguments, state);
  };
}

function wrappedCall(orig, mod, defaultProtocol, argsLike, state) {
  const args = Array.prototype.slice.call(argsLike);
  let ctx = null;
  try {
    ctx = context.getContext();
    if (ctx) injectTraceparent(args, ctx);
  } catch (e) {
    debug(state, e);
    ctx = null;
  }

  const req = orig.apply(mod, args);

  if (ctx) {
    try {
      instrumentRequest(req, ctx, defaultProtocol, state);
    } catch (e) {
      debug(state, e);
    }
  }
  return req;
}

/**
 * Inject the traceparent header into the request arguments *before* the
 * original call runs (http.get flushes headers synchronously, so mutating the
 * returned ClientRequest would be too late).
 * Signatures: (url[, options][, cb]) or (options[, cb]).
 */
function injectTraceparent(args, ctx) {
  const header = ids.buildTraceparent(ctx.traceId, ctx.spanId);

  const isUrlFirst = typeof args[0] === 'string' || args[0] instanceof URL;
  if (isUrlFirst) {
    if (args[1] && typeof args[1] === 'object') {
      addHeader(args[1], header);
    } else if (typeof args[1] === 'function' || args[1] === undefined || args[1] === null) {
      const cb = typeof args[1] === 'function' ? args[1] : args[2];
      args.length = 1;
      args.push({ headers: { traceparent: header } });
      if (typeof cb === 'function') args.push(cb);
    }
  } else if (args[0] && typeof args[0] === 'object') {
    addHeader(args[0], header);
  }
}

function addHeader(options, header) {
  try {
    if (options.headers === undefined || options.headers === null) {
      options.headers = { traceparent: header };
      return;
    }
    if (Array.isArray(options.headers)) {
      // Raw headers array form: append if not already present.
      for (let i = 0; i < options.headers.length; i += 2) {
        if (String(options.headers[i]).toLowerCase() === 'traceparent') return;
      }
      options.headers.push('traceparent', header);
      return;
    }
    if (typeof options.headers === 'object') {
      const keys = Object.keys(options.headers);
      for (let i = 0; i < keys.length; i++) {
        if (keys[i].toLowerCase() === 'traceparent') return;
      }
      options.headers.traceparent = header;
    }
  } catch (e) {
    /* frozen/exotic options: skip injection rather than break the call */
  }
}

function instrumentRequest(req, ctx, defaultProtocol, state) {
  const startHr = process.hrtime.bigint();
  let recorded = false;

  const record = (statusCode) => {
    if (recorded) return;
    recorded = true;
    try {
      const durationMs = Number(process.hrtime.bigint() - startHr) / 1e6;
      const protocol = req.protocol || defaultProtocol;
      const hostHeader = safeGetHeader(req, 'host') || req.host || 'localhost';
      const path = req.path || '/';
      const qi = path.indexOf('?');
      const uri = qi === -1 ? path : path.slice(0, qi);
      ctx.ops.http.push({
        url: protocol + '//' + hostHeader + path,
        method: req.method || 'GET',
        uri,
        status_code: statusCode,
        duration: durationMs
      });
    } catch (e) {
      debug(state, e);
    }
  };

  req.on('response', (res) => record((res && res.statusCode) || 0));
  req.on('error', () => record(0));
}

function safeGetHeader(req, name) {
  try {
    return req.getHeader(name);
  } catch (e) {
    return undefined;
  }
}

module.exports = { patch };
