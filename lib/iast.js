'use strict';

/**
 * Wave 19: IAST-lite — detection-only dangerous sink reporting.
 * Never blocks; emits type:iast for the agent.
 */

const REQUEST_MARKERS = [
  'req.query', 'req.body', 'req.params', 'req.headers',
  'event.queryStringParameters', 'event.body', 'event.pathParameters'
];

function looksRequestDerived(sqlOrArg) {
  if (typeof sqlOrArg !== 'string') return false;
  const s = sqlOrArg.toLowerCase();
  // Heuristic: string concat patterns or template literal leftovers with request-ish tokens.
  if (s.indexOf('${') >= 0 || s.indexOf('+') >= 0) {
    for (let i = 0; i < REQUEST_MARKERS.length; i++) {
      if (s.indexOf(REQUEST_MARKERS[i].toLowerCase()) >= 0) return true;
    }
  }
  // Also flag classic "SELECT ... '" + var patterns when evidence string mentions req
  if (/\b(select|insert|update|delete|union)\b/i.test(s) && /\breq\./i.test(s)) return true;
  return false;
}

function reportIAST(state, sink, evidence, extra) {
  try {
    if (!state || !state.transport) return;
    const cfg = state.config || {};
    const msg = Object.assign({
      type: 'iast',
      sink: sink,
      evidence: String(evidence || '').slice(0, 1024),
      service: cfg.service || '',
      organization_id: cfg.organizationId || cfg.organization_id || '',
      project_id: cfg.projectId || cfg.project_id || ''
    }, extra || {});
    state.transport.send(msg);
  } catch (_) { /* never throw into app */ }
}

/**
 * Inspect a SQL string; if it looks request-derived, emit an iast finding.
 * Call from SQL instrumentation wrappers — detection only.
 */
function checkSQL(state, sql, meta) {
  if (looksRequestDerived(sql)) {
    reportIAST(state, 'sql', sql, meta);
    return true;
  }
  return false;
}

function checkCommand(state, cmd, meta) {
  const s = Array.isArray(cmd) ? cmd.join(' ') : String(cmd || '');
  if (looksRequestDerived(s) || /\breq\./i.test(s)) {
    reportIAST(state, 'command', s, meta);
    return true;
  }
  return false;
}

function checkFile(state, pathArg, meta) {
  const s = String(pathArg || '');
  if (looksRequestDerived(s) || /\breq\./i.test(s)) {
    reportIAST(state, 'file', s, meta);
    return true;
  }
  return false;
}

function checkDeserialize(state, evidence, meta) {
  reportIAST(state, 'deserialize', evidence, meta);
  return true;
}

/**
 * Soft-wrap child_process.exec / execSync for detection (does not replace module permanently
 * unless installHooks is called).
 */
function installHooks(state) {
  try {
    const cp = require('child_process');
    if (cp.__opaIast) return;
    const origExec = cp.exec;
    const origExecSync = cp.execSync;
    cp.exec = function (command) {
      checkCommand(state, command, { route: '' });
      return origExec.apply(this, arguments);
    };
    cp.execSync = function (command) {
      checkCommand(state, command, { route: '' });
      return origExecSync.apply(this, arguments);
    };
    cp.__opaIast = true;
  } catch (_) { /* optional */ }
}

module.exports = {
  looksRequestDerived,
  checkSQL,
  checkCommand,
  checkFile,
  checkDeserialize,
  reportIAST,
  installHooks
};
