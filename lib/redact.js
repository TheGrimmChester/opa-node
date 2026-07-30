'use strict';

/**
 * Wave 13-4: client-side PII redaction (mirrors agent OPA_REDACT).
 */

const DEFAULT_KEYS = [
  'password', 'passwd', 'secret', 'token', 'authorization', 'api_key', 'apikey',
  'access_token', 'refresh_token', 'credit_card', 'card_number', 'ssn', 'cvv'
];

function normalizeKey(k) {
  return String(k || '').toLowerCase().replace(/[-_]/g, '');
}

function buildKeySet(extra) {
  const set = new Set(DEFAULT_KEYS.map(normalizeKey));
  (extra || []).forEach((k) => {
    const n = normalizeKey(k);
    if (n) set.add(n);
  });
  return set;
}

function shouldRedact(key, keySet) {
  const nk = normalizeKey(key);
  if (!nk) return false;
  for (const term of keySet) {
    if (nk.includes(term) || term.includes(nk)) return true;
  }
  return false;
}

function redactValue() {
  return '[REDACTED]';
}

function redactObject(obj, keySet, depth) {
  if (depth > 6 || obj == null) return obj;
  if (Array.isArray(obj)) {
    return obj.map((v) => (typeof v === 'object' ? redactObject(v, keySet, depth + 1) : v));
  }
  if (typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (shouldRedact(k, keySet)) out[k] = redactValue();
    else if (v && typeof v === 'object') out[k] = redactObject(v, keySet, depth + 1);
    else out[k] = v;
  }
  return out;
}

function redactSqlLiterals(sql) {
  if (!sql || typeof sql !== 'string') return sql;
  return sql
    .replace(/'([^'\\]|\\.)*'/g, "'?'")
    .replace(/"([^"\\]|\\.)*"/g, '"?"')
    .replace(/\b\d+(\.\d+)?\b/g, '?');
}

function createRedactor(config) {
  const enabled = !!(config && config.redact);
  const keySet = buildKeySet(config && config.redactKeys);
  return {
    enabled,
    scrubTags(tags) {
      if (!enabled || !tags || typeof tags !== 'object') return tags;
      return redactObject(tags, keySet, 0);
    },
    scrubSql(sql) {
      if (!enabled) return sql;
      return redactSqlLiterals(sql);
    }
  };
}

module.exports = { createRedactor, redactSqlLiterals, DEFAULT_KEYS };
