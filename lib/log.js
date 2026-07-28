'use strict';

// Structured log shipping. The OPA agent accepts log lines on the SAME ND-JSON
// socket as spans — a line with {"type":"log", ...} is written to opa.logs and
// surfaces on the dashboard's Logs page. When called inside a span, the log
// carries that trace/span id, so it is correlated to the request and the Logs
// page can jump straight to the trace.

const context = require('./context');

// Matches the agent's LogMessage struct (main.go). Only these keys are read.
function buildLogLine(state, level, message, fields) {
  const config = state.config || {};
  const line = {
    type: 'log',
    level: String(level || 'INFO').toUpperCase(),
    message: message == null ? '' : String(message),
    service: config.service || 'node-app',
    timestamp_ms: Date.now(),
    trace_id: '',
    span_id: null,
    fields: fields && typeof fields === 'object' ? fields : {},
  };
  if (config.organizationId) line.organization_id = config.organizationId;
  if (config.projectId) line.project_id = config.projectId;

  // Correlate to the active request when there is one.
  const ctx = context.getContext();
  if (ctx) {
    if (ctx.traceId) line.trace_id = ctx.traceId;
    if (ctx.spanId) line.span_id = ctx.spanId;
  }
  return line;
}

/**
 * Ship one structured log line. Safe to call before start(), after shutdown(),
 * or with the agent disabled — it simply does nothing.
 *
 * @param {string} level   INFO | WARN | ERROR | DEBUG (free-form, upper-cased)
 * @param {string} message
 * @param {object} [fields] structured context stored alongside the message
 */
function log(state, level, message, fields) {
  try {
    const transport = state.transport;
    if (!transport) return;
    transport.send(buildLogLine(state, level, message, fields));
  } catch (e) {
    // Logging must never break the caller.
  }
}

module.exports = { log, buildLogLine };
