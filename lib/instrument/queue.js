'use strict';

/**
 * Agent coverage: queue / worker naming helpers (Bull, Bee-Queue style).
 * Produces messaging.* attributes compatible with OTel semconv → OPA columns.
 */

function queueSpanName(system, destination, operation) {
  const op = operation || 'process';
  const dest = destination || 'unknown';
  return `${system || 'queue'} ${op} ${dest}`;
}

function queueTags(opts) {
  opts = opts || {};
  return {
    'messaging.system': opts.system || 'unknown',
    'messaging.destination': opts.destination || '',
    'messaging.destination.name': opts.destination || '',
    'messaging.operation': opts.operation || 'process',
    messaging_system: opts.system || 'unknown',
    messaging_destination: opts.destination || '',
    messaging_operation: opts.operation || 'process'
  };
}

/**
 * Wrap a job handler so the active OPA span (if any) carries queue identity.
 * @param {object} state agent state
 * @param {object} opts { system, destination, operation }
 * @param {Function} handler (job) => …
 */
function wrapProcessor(state, opts, handler) {
  return function wrapped(job) {
    try {
      const api = require('../api');
      if (api && typeof api.addTags === 'function') {
        api.addTags(queueTags(opts));
      }
    } catch (_) { /* ignore */ }
    return handler.apply(this, arguments);
  };
}

module.exports = { queueSpanName, queueTags, wrapProcessor };
