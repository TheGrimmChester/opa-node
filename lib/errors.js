'use strict';

/**
 * Error triage: application error capture for Node.
 *
 * Hooks uncaughtException / unhandledRejection and exposes captureException /
 * captureError for handled errors. Emits type:"error" ND-JSON on the shared
 * transport (same shape as the PHP extension).
 */

const crypto = require('crypto');
const context = require('./context');

function Errors(state) {
  this._state = state;
  this._hooked = false;
}

Errors.prototype._fingerprint = function (errorType, message, file, line) {
  const msg = String(message || '').replace(/\d+/g, '#').replace(/\/[^\s]+/g, '<path>');
  return errorType + ':' + msg + (file ? '@' + require('path').basename(file) : '') + (line ? ':' + line : '');
};

Errors.prototype._parseStack = function (err) {
  const stack = (err && err.stack) ? String(err.stack) : '';
  const frames = [];
  const lines = stack.split('\n').slice(1);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?/);
    if (!m) continue;
    const file = m[2] || '';
    const inApp = file.indexOf('node_modules') < 0 && !file.startsWith('node:');
    frames.push({
      function: m[1] || '<anonymous>',
      file: file,
      line: parseInt(m[3], 10) || 0,
      in_app: inApp
    });
  }
  return frames;
};

Errors.prototype.captureException = function (err, opts) {
  try {
    if (!this._state || !this._state.started || !this._state.transport) return;
    opts = opts || {};
    const handled = opts.handled !== false;
    const errorType = (err && err.name) ? err.name : 'Error';
    const message = (err && err.message) ? err.message : String(err);
    const frames = this._parseStack(err);
    const top = frames[0] || {};
    const fp = this._fingerprint(errorType, message, top.file, top.line);
    const ctx = context.getContext ? context.getContext() : null;
    const cfg = this._state.config || {};
    const payload = {
      type: 'error',
      trace_id: (ctx && ctx.traceId) || '',
      span_id: (ctx && ctx.spanId) || '',
      instance_id: crypto.randomBytes(8).toString('hex'),
      group_id: crypto.randomBytes(8).toString('hex'),
      fingerprint: fp,
      error_type: errorType,
      error_message: message,
      file: top.file || '',
      line: top.line || 0,
      stack_trace: frames,
      severity: opts.severity || 'error',
      handled: handled,
      mechanism: opts.mechanism || (handled ? 'captureException' : 'uncaughtException'),
      organization_id: cfg.organizationId || cfg.organization_id || '',
      project_id: cfg.projectId || cfg.project_id || '',
      service: cfg.service || 'node',
      environment: cfg.environment || process.env.OPA_ENVIRONMENT || process.env.NODE_ENV || '',
      release: cfg.release || process.env.OPA_RELEASE || '',
      occurred_at_ms: Date.now()
    };
    if (opts.tags) payload.tags = opts.tags;
    if (opts.user) payload.user_context = opts.user;
    this._state.transport.send(payload);
  } catch (e) { /* never break the app */ }
};

Errors.prototype.captureError = function (message, opts) {
  const err = message instanceof Error ? message : new Error(String(message));
  opts = opts || {};
  opts.handled = true;
  opts.mechanism = opts.mechanism || 'captureError';
  this.captureException(err, opts);
};

Errors.prototype.installHooks = function () {
  if (this._hooked) return;
  this._hooked = true;
  const self = this;
  process.on('uncaughtException', function (err) {
    self.captureException(err, { handled: false, mechanism: 'uncaughtException' });
  });
  process.on('unhandledRejection', function (reason) {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    self.captureException(err, { handled: false, mechanism: 'unhandledRejection' });
  });
};

module.exports = { Errors };
