'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { SamplingProfiler } = require('../lib/samplingProfiler');

test('sampling profiler aggregates Error.stack ticks', async () => {
  const sent = [];
  const state = {
    config: { service: 'svc', organizationId: 'o', projectId: 'p' },
    transport: { send: (p) => sent.push(p) }
  };
  const sp = new SamplingProfiler(state, { intervalMs: 20 });
  // Force fallback path (no inspector harvest during short test)
  sp._usingInspector = false;
  sp._session = null;
  for (let i = 0; i < 5; i++) sp._tick();
  sp.flush();
  assert.ok(sent.length >= 1);
  assert.strictEqual(sent[0].type, 'profile');
  assert.strictEqual(sent[0].profile_type, 'cpu');
  assert.ok(Array.isArray(sent[0].samples));
});
