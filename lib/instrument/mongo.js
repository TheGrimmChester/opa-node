'use strict';

/**
 * Agent coverage: optional mongodb driver patch (when installed).
 */

const context = require('../context');

let patched = false;

function optionalRequire(name) {
  try { return require(name); } catch (e) { return null; }
}

function recordMongo(entry) {
  try {
    const ctx = context.getContext();
    if (!ctx) return;
    if (!ctx.ops.mongo) ctx.ops.mongo = [];
    if (ctx.ops.mongo.length < 100) ctx.ops.mongo.push(entry);
  } catch (e) { /* ignore */ }
}

function patch(state) {
  if (patched) return false;
  patched = true;
  const mongodb = optionalRequire('mongodb');
  if (!mongodb || !mongodb.Collection) return false;
  try {
    const proto = mongodb.Collection.prototype;
    ['find', 'findOne', 'insertOne', 'insertMany', 'updateOne', 'updateMany',
      'deleteOne', 'deleteMany', 'aggregate', 'countDocuments'].forEach((method) => {
      const orig = proto[method];
      if (typeof orig !== 'function' || orig.__opaWrapped) return;
      proto[method] = function (...args) {
        const start = process.hrtime.bigint();
        const finish = (err) => {
          try {
            const duration = Number(process.hrtime.bigint() - start) / 1e6;
            const capture = !(state && state.config && state.config.captureArgs === false);
            recordMongo({
              db_system: 'mongodb',
              operation: method,
              collection: this && this.collectionName ? String(this.collectionName) : '',
              duration,
              error: err ? String(err.message || err) : undefined,
              // Never dump full docs; only arg arity when capture enabled.
              argc: capture ? args.length : 0
            });
          } catch (e) { /* ignore */ }
        };
        try {
          const out = orig.apply(this, args);
          if (out && typeof out.then === 'function') {
            return out.then((v) => { finish(null); return v; }, (err) => { finish(err); throw err; });
          }
          finish(null);
          return out;
        } catch (err) {
          finish(err);
          throw err;
        }
      };
      proto[method].__opaWrapped = true;
    });
    if (state && state.config && state.config.debug) {
      try { console.log('[opa-node] mongo instrumentation: mongodb'); } catch (e) { /* ignore */ }
    }
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { patch };
