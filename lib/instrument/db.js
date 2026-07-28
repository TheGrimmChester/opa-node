'use strict';

// Auto-instrumentation for the common Node data clients: pg, mysql2 and
// ioredis. None of them is a dependency of this package — each is patched only
// if the host application already has it installed, and skipped silently
// otherwise. Every wrapper calls through and swallows its own errors, so
// instrumentation can never change application behavior.

const context = require('./../context');

let patched = false;

function debug(state, where, e) {
  if (state && state.config && state.config.debug) {
    try { console.error('[opa-node db:' + where + ']', e && e.stack ? e.stack : e); } catch (err) { /* ignore */ }
  }
}

// require() the host app's copy, or null when it isn't installed.
function optionalRequire(name) {
  try {
    return require(name);
  } catch (e) {
    return null;
  }
}

function nowHr() {
  return process.hrtime.bigint();
}

function msSince(startHr) {
  return Number(nowHr() - startHr) / 1e6;
}

// Push a completed operation onto the active span. No span → nothing recorded.
function record(kind, entry) {
  try {
    const ctx = context.getContext();
    if (!ctx || !ctx.ops || !ctx.ops[kind]) return;
    ctx.ops[kind].push(entry);
  } catch (e) {
    // never propagate
  }
}

/**
 * Wrap a method whose result may be a promise, a callback, or neither.
 * `describe(args)` returns the entry to record (minus duration), or null to skip.
 */
function wrapMethod(target, methodName, kind, describe, state, label) {
  const original = target[methodName];
  if (typeof original !== 'function' || original.__opaWrapped) return;

  function wrapped(...args) {
    let entry = null;
    try {
      entry = describe(args);
    } catch (e) {
      debug(state, label, e);
    }
    // Nothing to measure (or no active span): stay out of the way entirely.
    if (!entry || !context.getContext()) return original.apply(this, args);

    const startHr = nowHr();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      record(kind, Object.assign({}, entry, { duration: msSince(startHr) }));
    };

    // Callback style: the driver calls the last argument when the query settles.
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      args[args.length - 1] = function opaCallback(...cbArgs) {
        finish();
        return last.apply(this, cbArgs);
      };
      try {
        return original.apply(this, args);
      } catch (e) {
        finish();
        throw e;
      }
    }

    let out;
    try {
      out = original.apply(this, args);
    } catch (e) {
      finish();
      throw e;
    }
    // Promise style.
    if (out && typeof out.then === 'function') {
      return out.then(
        (v) => { finish(); return v; },
        (e) => { finish(); throw e; },
      );
    }
    // Emitter/Submittable style (pg accepts a Submittable): time is unknown, so
    // record immediately rather than never.
    finish();
    return out;
  }

  wrapped.__opaWrapped = true;
  target[methodName] = wrapped;
}

// --- pg -------------------------------------------------------------------
// query(text) | query({text, values}) | query(submittable) [, values] [, cb]
function describePg(args) {
  const first = args[0];
  let text = null;
  if (typeof first === 'string') text = first;
  else if (first && typeof first.text === 'string') text = first.text;
  if (!text) return null;
  return { query: text };
}

function patchPg(state) {
  const pg = optionalRequire('pg');
  if (!pg) return false;
  try {
    if (pg.Client && pg.Client.prototype) wrapMethod(pg.Client.prototype, 'query', 'sql', describePg, state, 'pg.Client');
    if (pg.Pool && pg.Pool.prototype) wrapMethod(pg.Pool.prototype, 'query', 'sql', describePg, state, 'pg.Pool');
    return true;
  } catch (e) {
    debug(state, 'pg', e);
    return false;
  }
}

// --- mysql2 ---------------------------------------------------------------
// query(sql[, values][, cb]) | execute(...) — same first-argument shapes as pg.
function describeMysql(args) {
  const first = args[0];
  let text = null;
  if (typeof first === 'string') text = first;
  else if (first && typeof first.sql === 'string') text = first.sql;
  if (!text) return null;
  return { query: text };
}

function patchMysql2(state) {
  // The promise API wraps the same core Connection prototype, so patching the
  // base module covers `mysql2` and `mysql2/promise` alike.
  const mysql = optionalRequire('mysql2');
  if (!mysql) return false;
  try {
    const Connection = optionalRequire('mysql2/lib/connection');
    const proto = (Connection && Connection.prototype)
      || (mysql.Connection && mysql.Connection.prototype);
    if (proto) {
      wrapMethod(proto, 'query', 'sql', describeMysql, state, 'mysql2.query');
      wrapMethod(proto, 'execute', 'sql', describeMysql, state, 'mysql2.execute');
    }
    return !!proto;
  } catch (e) {
    debug(state, 'mysql2', e);
    return false;
  }
}

// --- ioredis --------------------------------------------------------------
// sendCommand(command) where command has .name and .args
function describeRedis(args) {
  const cmd = args[0];
  if (!cmd || typeof cmd.name !== 'string') return null;
  let key = '';
  try {
    if (Array.isArray(cmd.args) && cmd.args.length > 0) key = String(cmd.args[0]);
  } catch (e) {
    key = '';
  }
  return { command: cmd.name, key };
}

function patchIoredis(state) {
  const Redis = optionalRequire('ioredis');
  if (!Redis) return false;
  try {
    const proto = (Redis.prototype && Redis.prototype.sendCommand)
      ? Redis.prototype
      : (Redis.default && Redis.default.prototype); // ESM interop
    if (!proto) return false;
    wrapMethod(proto, 'sendCommand', 'redis', describeRedis, state, 'ioredis');
    return true;
  } catch (e) {
    debug(state, 'ioredis', e);
    return false;
  }
}

/**
 * Patch every data client the host app has installed. Idempotent.
 * Returns the list of instrumented module names (useful in tests/diagnostics).
 */
function patch(state) {
  if (patched) return [];
  patched = true;
  const on = [];
  if (patchPg(state)) on.push('pg');
  if (patchMysql2(state)) on.push('mysql2');
  if (patchIoredis(state)) on.push('ioredis');
  if (on.length && state && state.config && state.config.debug) {
    try { console.log('[opa-node] db instrumentation:', on.join(', ')); } catch (e) { /* ignore */ }
  }
  return on;
}

module.exports = { patch, wrapMethod, describePg, describeMysql, describeRedis };
