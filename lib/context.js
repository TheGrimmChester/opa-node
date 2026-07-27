'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

/**
 * Create a span context. Holds the active trace/span identifiers plus the
 * sub-operation buckets (ops) that instrumentation and the manual API push into.
 */
function createContext(fields) {
  return Object.assign(
    {
      traceId: null,
      spanId: null,
      parentId: null,
      ops: { http: [], sql: [], redis: [] },
      tags: {},
      stack: [],       // flat CallNode list built by the manual span() API
      callCounter: 0,  // call_id counter for stack nodes
      w3cTraceparent: null
    },
    fields || {}
  );
}

function getContext() {
  return als.getStore() || null;
}

function run(ctx, fn) {
  return als.run(ctx, fn);
}

module.exports = { als, createContext, getContext, run };
