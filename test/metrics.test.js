'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Metrics } = require('../lib/metrics');

test('Metrics pre-aggregates counters before flush', () => {
  const sent = [];
  const state = {
    started: true,
    config: { enabled: true, organizationId: 'o', projectId: 'p' },
    transport: { send: (m) => sent.push(m) }
  };
  const m = new Metrics(state);
  m.counter('orders', 1, { service: 'api' });
  m.counter('orders', 2, { service: 'api' });
  m.flush();
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].type, 'metric');
  assert.strictEqual(sent[0].metrics[0].value, 3);
  assert.strictEqual(sent[0].metrics[0].type, 'counter');
  m.stop();
});
