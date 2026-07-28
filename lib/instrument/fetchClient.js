'use strict';

const context = require('../context');
const ids = require('../ids');

let patched = false;

function debug(state, e) {
  if (state && state.config && state.config.debug) {
    try { console.error('[opa-node fetchClient]', e && e.stack ? e.stack : e); } catch (err) { /* ignore */ }
  }
}

/**
 * Patch the global fetch() (undici, Node >= 18):
 * - inject a W3C traceparent header carrying the active trace/span ids,
 * - time the call and push {url, method, uri, status_code, duration} into the
 *   active span context's ops.http (status_code 0 on rejection), exactly like
 *   the http/https client instrumentation.
 * With no active span the original fetch runs untouched. Any instrumentation
 * error falls back to the original call with the original arguments.
 */
function patch(state) {
  if (patched) return;
  patched = true;
  if (typeof globalThis.fetch !== 'function') return; // runtime without global fetch

  const origFetch = globalThis.fetch;

  globalThis.fetch = function fetch(input, init) {
    let ctx = null;
    try { ctx = context.getContext(); } catch (e) { ctx = null; }
    if (!ctx) return origFetch.apply(this, arguments);

    let args = arguments;
    let url = '';
    let method = 'GET';
    try {
      url = requestUrl(input);
      method = requestMethod(input, init);
      args = buildArgs(input, init, ids.buildTraceparent(ctx.traceId, ctx.spanId));
    } catch (e) {
      debug(state, e);
      args = arguments; // instrumentation failed: call through untouched
    }

    const startHr = process.hrtime.bigint();
    const record = (statusCode) => {
      try {
        ctx.ops.http.push({
          url,
          method,
          uri: pathnameOf(url),
          status_code: statusCode,
          duration: Number(process.hrtime.bigint() - startHr) / 1e6
        });
      } catch (e) {
        debug(state, e);
      }
    };

    let out;
    try {
      out = origFetch.apply(this, args);
    } catch (err) {
      if (args !== arguments) {
        // Our rebuilt arguments tripped a synchronous validation the original
        // arguments might pass: retry untouched rather than break the app.
        debug(state, err);
        return origFetch.apply(this, arguments);
      }
      throw err;
    }

    if (out && typeof out.then === 'function') {
      return out.then(
        (res) => {
          record(res && typeof res.status === 'number' ? res.status : 0);
          return res;
        },
        (err) => {
          record(0);
          throw err;
        }
      );
    }
    return out;
  };
}

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof Request === 'function' && input instanceof Request) return input.url;
  return String(input);
}

function requestMethod(input, init) {
  if (init && typeof init.method === 'string' && init.method.length > 0) {
    return init.method.toUpperCase();
  }
  if (typeof Request === 'function' && input instanceof Request && typeof input.method === 'string') {
    return input.method;
  }
  return 'GET';
}

function pathnameOf(url) {
  try {
    return new URL(url).pathname;
  } catch (e) {
    const s = String(url);
    const qi = s.indexOf('?');
    return qi === -1 ? s : s.slice(0, qi);
  }
}

/**
 * Rebuild the (input, init) pair with a traceparent header injected via the
 * Headers API. Handles input being URL/string/Request and init.headers being
 * Headers/array/plain object. A caller-provided traceparent is never
 * overwritten. The caller's own objects are never mutated: headers are copied
 * into a fresh Headers instance carried by a shallow init clone (per the fetch
 * spec, init.headers replaces the Request's headers, so copying the Request's
 * headers into init when init has none is equivalent).
 */
function buildArgs(input, init, header) {
  const isRequest = typeof Request === 'function' && input instanceof Request;
  let headers;
  if (init && init.headers !== undefined && init.headers !== null) {
    headers = new Headers(init.headers); // Headers | [name, value][] | object
  } else if (isRequest) {
    headers = new Headers(input.headers);
  } else {
    headers = new Headers();
  }
  if (!headers.has('traceparent')) headers.set('traceparent', header);
  return [input, Object.assign({}, init || {}, { headers })];
}

module.exports = { patch };
