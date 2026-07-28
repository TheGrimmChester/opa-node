'use strict';

// DB auto-instrumentation (pg / mysql2 / ioredis) and log shipping.
// Run with: node test/db-log.test.js
//
// The drivers are not dependencies, so the test builds minimal fakes with the
// same shapes the real modules expose and registers them in require.cache
// BEFORE the agent starts — which is exactly the path patch() takes.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const path = require('node:path');

process.env.OPA_ORGANIZATION_ID = 'org-test';
process.env.OPA_PROJECT_ID = 'proj-test';
process.env.OPA_SAMPLING_RATE = '1';

// --- fake drivers, registered before requiring the agent -------------------

// pg: promise-style query(text | {text}) on Client.prototype
class FakePgClient {
  query(config) {
    const text = typeof config === 'string' ? config : (config && config.text);
    return Promise.resolve({ rows: [], command: text });
  }
}
// mysql2: callback-style query/execute on the core Connection prototype.
// query and execute are INDEPENDENT here, as they are in the real driver
// (execute builds an Execute command rather than delegating to query) — if the
// fake delegated, the delegating call would be recorded by both wrappers.
class FakeMysqlConnection {
  query(sql, values, cb) {
    const done = typeof values === 'function' ? values : cb;
    if (typeof done === 'function') setImmediate(() => done(null, [], []));
    return undefined;
  }
  execute(sql, values, cb) {
    const done = typeof values === 'function' ? values : cb;
    if (typeof done === 'function') setImmediate(() => done(null, [], []));
    return undefined;
  }
}
// ioredis: promise-style sendCommand(Command{name,args})
class FakeRedis {
  sendCommand(cmd) {
    return Promise.resolve('OK:' + cmd.name);
  }
}

function register(name, exportsObj) {
  // A resolvable id is required for require.cache; use this file's own path as
  // the module filename so Node treats the entry as already loaded.
  const Module = require('node:module');
  const filename = path.join(__dirname, `__fake_${name.replace(/[^a-z0-9]/gi, '_')}.js`);
  const m = new Module(filename, null);
  m.filename = filename;
  m.loaded = true;
  m.exports = exportsObj;
  require.cache[filename] = m;
  // Point the bare specifier at our fake by overriding resolution.
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === name) return filename;
    return origResolve.call(this, request, ...rest);
  };
}

register('pg', { Client: FakePgClient });
register('mysql2', { Connection: FakeMysqlConnection });
register('mysql2/lib/connection', FakeMysqlConnection);
register('ioredis', FakeRedis);

const opa = require('../lib/index');

let collector;

async function waitFor(fn, timeoutMs, what) {
  const start = Date.now();
  while (Date.now() - start < (timeoutMs || 4000)) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout waiting for ' + (what || 'condition'));
}

function startMockCollector() {
  return new Promise((resolve, reject) => {
    const lines = [];
    const sockets = new Set();
    const server = net.createServer((sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
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
    server.listen(0, '127.0.0.1', () => resolve({
      server, lines, port: server.address().port,
      stop: () => { sockets.forEach((s) => s.destroy()); server.close(); },
    }));
  });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function stopServer(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  server.close();
}

before(async () => {
  collector = await startMockCollector();
  opa.start({
    socketPath: '127.0.0.1:' + collector.port,
    service: 'db-log-test',
    samplingRate: 1,
  });
});

after(async () => {
  await opa.shutdown();
  collector.stop();
});

test('pg / mysql2 / ioredis calls inside a span land on the span', async () => {
  const app = http.createServer(async (req, res) => {
    const pgClient = new FakePgClient();
    await pgClient.query('SELECT * FROM users WHERE id = $1');
    await pgClient.query({ text: 'UPDATE users SET seen = now()' });

    const my = new FakeMysqlConnection();
    await new Promise((r) => my.query('SELECT 1 FROM dual', r));
    await new Promise((r) => my.execute('INSERT INTO audit VALUES (?)', [1], r));

    const redis = new FakeRedis();
    await redis.sendCommand({ name: 'get', args: ['user:42'] });

    res.end('ok');
  });
  const port = await listen(app);

  try {
    await (await fetch(`http://127.0.0.1:${port}/db-work`)).text();
    const span = await waitFor(
      () => collector.lines.find((l) => l.url_path === '/db-work'),
      4000, 'span for /db-work');

    const queries = (span.sql || []).map((s) => s.query);
    assert.strictEqual(queries.length, 4, 'both pg calls and both mysql2 calls recorded');
    assert.ok(queries.includes('SELECT * FROM users WHERE id = $1'), 'pg string form');
    assert.ok(queries.includes('UPDATE users SET seen = now()'), 'pg {text} form');
    assert.ok(queries.includes('SELECT 1 FROM dual'), 'mysql2 query (callback)');
    assert.ok(queries.includes('INSERT INTO audit VALUES (?)'), 'mysql2 execute (callback)');
    for (const s of span.sql) {
      assert.ok(typeof s.duration === 'number' && s.duration >= 0, 'each sql entry is timed');
    }

    assert.strictEqual((span.redis || []).length, 1);
    assert.strictEqual(span.redis[0].command, 'get');
    assert.strictEqual(span.redis[0].key, 'user:42');
  } finally {
    stopServer(app);
  }
});

test('driver calls outside a span are a safe pass-through', async () => {
  const pgClient = new FakePgClient();
  const r1 = await pgClient.query('SELECT 1');
  assert.strictEqual(r1.command, 'SELECT 1', 'original return value preserved');

  const redis = new FakeRedis();
  assert.strictEqual(await redis.sendCommand({ name: 'ping', args: [] }), 'OK:ping');

  const my = new FakeMysqlConnection();
  await new Promise((r) => my.query('SELECT 2', r)); // must not throw
});

test('opa.log() ships a structured log line with the configured tenant', async () => {
  opa.logWarn('disk almost full', { pct: 91 });

  const line = await waitFor(
    () => collector.lines.find((l) => l.type === 'log' && l.message === 'disk almost full'),
    4000, 'log line');

  assert.strictEqual(line.level, 'WARN');
  assert.strictEqual(line.service, 'db-log-test');
  assert.strictEqual(line.organization_id, 'org-test');
  assert.strictEqual(line.project_id, 'proj-test');
  assert.deepStrictEqual(line.fields, { pct: 91 });
  assert.ok(typeof line.timestamp_ms === 'number' && line.timestamp_ms > 0);
  assert.strictEqual(line.trace_id, '', 'no trace when logged outside a request');
});

test('a log emitted inside a request carries that trace id', async () => {
  const app = http.createServer((req, res) => {
    opa.logError('checkout failed', { order: 'A-1' });
    res.end('ok');
  });
  const port = await listen(app);

  try {
    await (await fetch(`http://127.0.0.1:${port}/with-log`)).text();

    const span = await waitFor(
      () => collector.lines.find((l) => l.url_path === '/with-log'), 4000, 'span');
    const line = await waitFor(
      () => collector.lines.find((l) => l.type === 'log' && l.message === 'checkout failed'),
      4000, 'log line');

    assert.strictEqual(line.level, 'ERROR');
    assert.strictEqual(line.trace_id, span.trace_id, 'log is correlated to the request trace');
    assert.strictEqual(line.span_id, span.span_id, 'and to the span');
  } finally {
    stopServer(app);
  }
});
