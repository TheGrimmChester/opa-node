'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { looksRequestDerived, checkSQL } = require('../lib/iast');

test('looksRequestDerived detects concat with req.query', () => {
  assert.equal(looksRequestDerived('SELECT * FROM users WHERE id = 1'), false);
  assert.equal(looksRequestDerived("SELECT * FROM t WHERE id=' + req.query.id + '"), true);
});

test('checkSQL reports via transport', () => {
  const sent = [];
  const state = { config: { service: 'api' }, transport: { send: (m) => sent.push(m) } };
  assert.equal(checkSQL(state, "SELECT * FROM u WHERE name=' + req.body.name"), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'iast');
  assert.equal(sent[0].sink, 'sql');
});
