'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { cliTransactionName, graphqlSpanName, grpcSpanName } = require('../lib/instrument/xcut');
const { createRedactor } = require('../lib/redact');
const { resolveConfig } = require('../lib/config');

test('cliTransactionName collapses ids', () => {
  const name = cliTransactionName(['node', 'scripts/job.js', '--id', 'abc', '12345', 'rebuild']);
  assert.match(name, /job\.js/);
  assert.ok(name.includes(':id') || name.includes('rebuild'));
});

test('graphql / grpc span names', () => {
  assert.strictEqual(graphqlSpanName('GetUser', 'query'), 'GraphQL query GetUser');
  assert.strictEqual(grpcSpanName('Billing', 'Charge'), 'grpc Billing/Charge');
});

test('redactor masks sensitive keys', () => {
  const r = createRedactor({ redact: true, redactKeys: [] });
  const out = r.scrubTags({ user: 'a', password: 'secret', nested: { api_key: 'x' } });
  assert.strictEqual(out.password, '[REDACTED]');
  assert.strictEqual(out.nested.api_key, '[REDACTED]');
  assert.strictEqual(out.user, 'a');
});

test('resolveConfig exposes redact + framework + api port', () => {
  const cfg = resolveConfig({ service: 't', redact: true, framework: 'express' });
  assert.strictEqual(cfg.redact, true);
  assert.strictEqual(cfg.framework, 'express');
  assert.strictEqual(cfg.apiPort, 8088);
  assert.strictEqual(cfg.captureSql, true);
});
