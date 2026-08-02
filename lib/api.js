'use strict';

const context = require('./context');

/**
 * Manual sub-operation timing. Runs fn (sync or promise-returning) and records
 * it as a flat CallNode in the active span's stack. Nodes are attached as
 * depth-1 children under a single root node (representing the handler) when
 * the span is built. Outside an active span, fn simply runs untimed.
 *
 * @param {string} name
 * @param {Function} fn
 */
function span(name, fn) {
  const ctx = context.getContext();
  if (!ctx) return fn();

  ctx.callCounter += 1;
  const callId = 'c' + ctx.callCounter;
  const startHr = process.hrtime.bigint();
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    try {
      const durationMs = Number(process.hrtime.bigint() - startHr) / 1e6;
      ctx.stack.push({
        call_id: callId,
        function: String(name),
        class: '',
        file: '',
        line: 0,
        duration_ms: durationMs,
        cpu_ms: 0,
        memory_delta: 0,
        parent_id: '',
        depth: 0,
        call_site: ''
      });
    } catch (e) { /* never break app code */ }
  };

  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      return out.then(
        (v) => { finish(); return v; },
        (err) => { finish(); throw err; }
      );
    }
    finish();
    return out;
  } catch (err) {
    finish();
    throw err;
  }
}

/**
 * Record a SQL query executed during the active span.
 */
function recordSql(query, durationMs) {
  try {
    const ctx = context.getContext();
    if (!ctx) return;
    ctx.ops.sql.push({ query: String(query), duration: Number(durationMs) || 0 });
  } catch (e) { /* ignore */ }
}

/**
 * Record a Redis command executed during the active span.
 */
function recordRedis(command, key, durationMs) {
  try {
    const ctx = context.getContext();
    if (!ctx) return;
    ctx.ops.redis.push({
      command: String(command),
      key: key === undefined || key === null ? '' : String(key),
      duration: Number(durationMs) || 0
    });
  } catch (e) { /* ignore */ }
}

/**
 * Merge custom tags into the active span.
 */
function addTags(obj) {
  try {
    const ctx = context.getContext();
    if (!ctx || !obj || typeof obj !== 'object') return;
    Object.assign(ctx.tags, obj);
  } catch (e) { /* ignore */ }
}

module.exports = { span, recordSql, recordRedis, addTags };
