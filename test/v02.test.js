'use strict';

// v0.2 capabilities: global fetch() instrumentation and framework route
// templates. Run with: node test/v02.test.js
//
// start() is idempotent by design, so the whole file shares ONE agent and ONE
// mock collector; each test filters the collected lines for its own span.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');

process.env.OPA_ORGANIZATION_ID = 'org-test';
process.env.OPA_PROJECT_ID = 'proj-test';
process.env.OPA_SAMPLING_RATE = '1';

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
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        lines,
        port: server.address().port,
        // The agent keeps a long-lived connection; server.close() alone would
        // wait on it forever and hang the test process.
        stop: () => { sockets.forEach((s) => s.destroy()); server.close(); }
      });
    });
  });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// undici (global fetch) uses keep-alive, so idle client connections would keep
// these servers — and the event loop — alive.
function stopServer(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  server.close();
}

before(async () => {
  collector = await startMockCollector();
  opa.start({
    socketPath: '127.0.0.1:' + collector.port,
    service: 'v02-test',
    samplingRate: 1
  });
});

after(async () => {
  await opa.shutdown();
  collector.stop();
});

test('global fetch(): outbound call recorded + traceparent propagated', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.traceparent || null);
    res.statusCode = 204;
    res.end();
  });
  const upstreamPort = await listen(upstream);

  const app = http.createServer(async (req, res) => {
    try {
      // The default HTTP client on Node >= 18 — undici, not http.request.
      const r = await fetch('http://127.0.0.1:' + upstreamPort + '/edge?q=1');
      res.end(String(r.status));
    } catch (e) {
      res.statusCode = 500;
      res.end('err');
    }
  });
  const appPort = await listen(app);

  try {
    const resp = await fetch('http://127.0.0.1:' + appPort + '/uses-fetch');
    assert.strictEqual(resp.status, 200);
    await resp.text();

    const span = await waitFor(
      () => collector.lines.find((l) => l.url_path === '/uses-fetch'),
      4000,
      'span for /uses-fetch'
    );

    assert.ok(Array.isArray(span.http), 'span carries an http array');
    assert.strictEqual(span.http.length, 1, 'the fetch() call was recorded');
    const call = span.http[0];
    assert.match(call.url, /\/edge\?q=1$/);
    assert.strictEqual(call.method, 'GET');
    assert.strictEqual(call.uri, '/edge', 'uri is the pathname without the query');
    assert.strictEqual(call.status_code, 204);
    assert.ok(typeof call.duration === 'number' && call.duration >= 0);

    // Distributed propagation: the upstream saw a traceparent whose trace id is
    // this span's trace id and whose parent is this span's id.
    assert.strictEqual(seen.length, 1);
    assert.ok(seen[0], 'upstream received a traceparent header');
    const parts = seen[0].split('-');
    assert.strictEqual(parts[0], '00');
    assert.strictEqual(parts[1], span.trace_id, 'propagated trace id matches the caller span');
    assert.strictEqual(parts[2], span.span_id, 'propagated parent id is the caller span id');
  } finally {
    stopServer(app);
    stopServer(upstream);
  }
});

test('global fetch(): a caller-supplied traceparent is never overwritten', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.traceparent || null);
    res.end();
  });
  const upstreamPort = await listen(upstream);

  const explicit = '00-' + 'c'.repeat(32) + '-' + 'd'.repeat(16) + '-01';
  const app = http.createServer(async (req, res) => {
    await fetch('http://127.0.0.1:' + upstreamPort + '/x', {
      headers: { traceparent: explicit, 'x-custom': 'kept' }
    });
    res.end('ok');
  });
  const appPort = await listen(app);

  try {
    await (await fetch('http://127.0.0.1:' + appPort + '/explicit')).text();
    await waitFor(() => collector.lines.find((l) => l.url_path === '/explicit'), 4000, 'span');
    assert.strictEqual(seen[0], explicit, 'the app’s own traceparent wins');
  } finally {
    stopServer(app);
    stopServer(upstream);
  }
});

test('route templates group Express and Fastify endpoints', async () => {
  // The span is built when the response finishes, so setting the framework
  // fields on `req` inside the handler mirrors what Express/Fastify do before
  // the handler runs.
  const app = http.createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (path.startsWith('/users/')) {
      req.baseUrl = '/users';            // express Router mount prefix
      req.route = { path: '/:id' };      // express matched route
    } else if (path.startsWith('/items/')) {
      req.routeOptions = { url: '/items/:sku' }; // fastify v4+
    }
    res.end('ok');
  });
  const appPort = await listen(app);

  try {
    await (await fetch('http://127.0.0.1:' + appPort + '/users/42')).text();
    await (await fetch('http://127.0.0.1:' + appPort + '/items/abc-9')).text();
    await (await fetch('http://127.0.0.1:' + appPort + '/plain/path')).text();

    const express = await waitFor(
      () => collector.lines.find((l) => l.url_path === '/users/42'), 4000, 'express span');
    const fastify = await waitFor(
      () => collector.lines.find((l) => l.url_path === '/items/abc-9'), 4000, 'fastify span');
    const plain = await waitFor(
      () => collector.lines.find((l) => l.url_path === '/plain/path'), 4000, 'plain span');

    assert.strictEqual(express.name, 'GET /users/:id', 'express template joins baseUrl + route.path');
    assert.strictEqual(fastify.name, 'GET /items/:sku', 'fastify template used as-is');
    assert.strictEqual(plain.name, 'GET /plain/path', 'no template -> concrete path');

    // The concrete path is still preserved for filtering/drill-down.
    assert.strictEqual(express.url_path, '/users/42');
  } finally {
    stopServer(app);
  }
});
