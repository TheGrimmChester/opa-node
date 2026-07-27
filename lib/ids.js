'use strict';

const crypto = require('crypto');

/**
 * W3C traceparent: version "00" - 32 hex trace-id - 16 hex parent-id - 2 hex flags.
 * Lowercase hex only, all-zero ids are invalid per the spec.
 */
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

function newTraceId() {
  return crypto.randomBytes(16).toString('hex');
}

function newSpanId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Parse a traceparent header value.
 * @param {string} header
 * @returns {{traceId: string, parentId: string} | null}
 */
function parseTraceparent(header) {
  if (typeof header !== 'string') return null;
  const m = TRACEPARENT_RE.exec(header.trim());
  if (!m) return null;
  const traceId = m[2];
  const parentId = m[3];
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return null;
  return { traceId, parentId };
}

/**
 * Build a traceparent header for outbound propagation (sampled flag set).
 */
function buildTraceparent(traceId, spanId) {
  return '00-' + traceId + '-' + spanId + '-01';
}

module.exports = { newTraceId, newSpanId, parseTraceparent, buildTraceparent };
