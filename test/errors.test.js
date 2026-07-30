'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');

process.env.OPA_ORGANIZATION_ID = 'org-err';
process.env.OPA_PROJECT_ID = 'proj-err';
process.env.OPA_SAMPLING_RATE = '1';
process.env.OPA_RELEASE = 'v10';

const { Errors } = require('../lib/errors');

function startMockCollector() {
  return new Promise((resolve, reject) => {
    const lines = [];
    const server = net.createServer((sock) => {
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) lines.push(JSON.parse(line));
        }
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, lines, port: server.address().port });
    });
  });
}

test('errors: captureException emits type:error with handled=true', async () => {
  const mock = await startMockCollector();
  const sent = [];
  const state = {
    started: true,
    config: { organizationId: 'org-err', projectId: 'proj-err', service: 'svc', environment: 'test', release: 'v10' },
    transport: { send: (p) => { sent.push(p); mock.lines.push(p); } }
  };
  const errors = new Errors(state);
  const err = new Error('boom 42');
  err.stack = 'Error: boom 42\n    at foo (/app/src/foo.js:10:5)\n    at Object.<anonymous> (/app/node_modules/x/index.js:1:1)';
  errors.captureException(err);
  assert.strictEqual(sent.length, 1);
  const p = sent[0];
  assert.strictEqual(p.type, 'error');
  assert.strictEqual(p.handled, true);
  assert.strictEqual(p.severity, 'error');
  assert.strictEqual(p.mechanism, 'captureException');
  assert.ok(Array.isArray(p.stack_trace) && p.stack_trace.length >= 1);
  assert.strictEqual(p.stack_trace[0].in_app, true);
  assert.strictEqual(p.release, 'v10');
  mock.server.close();
});

test('errors: unhandled path sets handled=false', () => {
  const sent = [];
  const state = {
    started: true,
    config: { service: 'svc' },
    transport: { send: (p) => sent.push(p) }
  };
  const errors = new Errors(state);
  errors.captureException(new Error('uncaught'), { handled: false, mechanism: 'uncaughtException' });
  assert.strictEqual(sent[0].handled, false);
  assert.strictEqual(sent[0].mechanism, 'uncaughtException');
});
