'use strict';

// Dependency-free tests for the opa-node agent. Run with: node test/unit.test.js

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');

// Environment must be set before the agent resolves its config.
process.env.OPA_ORGANIZATION_ID = 'org-test';
process.env.OPA_PROJECT_ID = 'proj-test';
process.env.OPA_SAMPLING_RATE = '1';

const ids = require('../lib/ids');
const { resolveConfig, parseSocketPath } = require('../lib/config');
const opa = require('../lib/index');

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

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

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('ids: trace and span id formats', () => {
  const t = ids.newTraceId();
  const s = ids.newSpanId();
  assert.match(t, HEX32, 'trace id is 32 lowercase hex');
  assert.match(s, HEX16, 'span id is 16 lowercase hex');
  assert.notStrictEqual(ids.newTraceId(), ids.newTraceId(), 'trace ids are random');
  assert.notStrictEqual(ids.newSpanId(), ids.newSpanId(), 'span ids are random');
});

test('ids: traceparent parse and build', () => {
  const traceId = 'a'.repeat(32);
  const parentId = 'b'.repeat(16);
  const good = `00-${traceId}-${parentId}-01`;

  const parsed = ids.parseTraceparent(good);
  assert.ok(parsed, 'valid header parses');
  assert.strictEqual(parsed.traceId, traceId);
  assert.strictEqual(parsed.parentId, parentId);

  assert.strictEqual(ids.parseTraceparent(undefined), null);
  assert.strictEqual(ids.parseTraceparent(''), null);
  assert.strictEqual(ids.parseTraceparent('not-a-header'), null);
  assert.strictEqual(ids.parseTraceparent(`00-${'A'.repeat(32)}-${parentId}-01`), null, 'uppercase rejected');
  assert.strictEqual(ids.parseTraceparent(`00-${'0'.repeat(32)}-${parentId}-01`), null, 'all-zero trace id rejected');
  assert.strictEqual(ids.parseTraceparent(`00-${traceId}-${'0'.repeat(16)}-01`), null, 'all-zero parent id rejected');
  assert.strictEqual(ids.parseTraceparent(`00-${traceId}-${parentId}`), null, 'missing flags rejected');

  assert.strictEqual(ids.buildTraceparent(traceId, parentId), good.slice(0, -2) + '01');
});

test('config: resolution precedence and defaults', () => {
  // options > env
  const cfg = resolveConfig({ service: 'from-options', samplingRate: 0.5, socketPath: '10.0.0.1:1234' });
  assert.strictEqual(cfg.service, 'from-options');
  assert.strictEqual(cfg.samplingRate, 0.5);
  assert.strictEqual(cfg.host, '10.0.0.1');
  assert.strictEqual(cfg.port, 1234);
  assert.strictEqual(cfg.organizationId, 'org-test', 'env fallback');
  assert.strictEqual(cfg.projectId, 'proj-test');
  assert.strictEqual(cfg.enabled, true, 'OPA_ENABLED defaults to on');

  // env only
  process.env.OPA_SERVICE = 'from-env';
  const cfg2 = resolveConfig();
  assert.strictEqual(cfg2.service, 'from-env');
  assert.strictEqual(cfg2.samplingRate, 1, 'default sampling rate');
  delete process.env.OPA_SERVICE;

  // defaults + clamping
  const cfg3 = resolveConfig({ samplingRate: 7 });
  assert.strictEqual(cfg3.samplingRate, 1, 'sampling rate clamped to 1');
  const cfg4 = resolveConfig({ samplingRate: -1 });
  assert.strictEqual(cfg4.samplingRate, 0, 'sampling rate clamped to 0');
  assert.strictEqual(resolveConfig().socketPath, '127.0.0.1:9090', 'default socket path');

  assert.deepStrictEqual(parseSocketPath('opa-agent:9090'), { host: 'opa-agent', port: 9090 });

  const cfgOff = resolveConfig({ enabled: false });
  assert.strictEqual(cfgOff.enabled, false);
});

test('end-to-end: spans over TCP match the wire contract', async () => {
  const collector = await startMockCollector();

  opa.start({
    socketPath: '127.0.0.1:' + collector.port,
    service: 'unit-test-service',
    samplingRate: 1
  });

  // Upstream target for outbound calls (itself instrumented -> emits a span too).
  const upstream = http.createServer((req, res) => {
    res.statusCode = 200;
    res.end('up');
  });
  const upstreamPort = await listen(upstream);

  // The application under test.
  const app = http.createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (path === '/hello') {
      http.get('http://127.0.0.1:' + upstreamPort + '/up', (r) => {
        r.resume();
        r.on('end', () => res.end('hi'));
      });
    } else if (path === '/db') {
      opa.recordSql('SELECT * FROM users WHERE id = ?', 1.25);
      opa.recordRedis('get', 'user:1', 0.4);
      opa.addTags({ custom_tag: 'yes' });
      opa.span('compute', () => {
        let x = 0;
        for (let i = 0; i < 1000; i++) x += i;
        return x;
      });
      res.end('db');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  const appPort = await listen(app);

  try {
    // --- request with inbound traceparent + outbound call -------------------
    const inboundTrace = 'a'.repeat(32);
    const inboundParent = 'b'.repeat(16);
    const inboundHeader = `00-${inboundTrace}-${inboundParent}-01`;

    const r1 = await fetch(`http://127.0.0.1:${appPort}/hello?x=1`, {
      headers: { traceparent: inboundHeader }
    });
    assert.strictEqual(r1.status, 200);
    await r1.text();

    const helloSpan = await waitFor(
      () => collector.lines.find((l) => l.url_path === '/hello'),
      4000,
      '/hello span'
    );

    assert.strictEqual(helloSpan.type, 'span');
    assert.strictEqual(helloSpan.trace_id, inboundTrace, 'adopts inbound trace id');
    assert.strictEqual(helloSpan.parent_id, inboundParent, 'adopts inbound parent id');
    assert.match(helloSpan.span_id, HEX16);
    assert.strictEqual(helloSpan.service, 'unit-test-service');
    assert.strictEqual(helloSpan.name, 'GET /hello', 'name strips the query string');
    assert.strictEqual(helloSpan.url_scheme, 'http');
    assert.strictEqual(helloSpan.url_host, '', 'inbound url_host must be empty');
    assert.strictEqual(helloSpan.url_path, '/hello');
    assert.ok(Number.isInteger(helloSpan.start_ts), 'start_ts integer epoch ms');
    assert.ok(Number.isInteger(helloSpan.end_ts), 'end_ts integer epoch ms');
    assert.ok(helloSpan.end_ts >= helloSpan.start_ts);
    assert.strictEqual(typeof helloSpan.duration_ms, 'number');
    assert.ok(helloSpan.duration_ms >= 0);
    assert.strictEqual(typeof helloSpan.cpu_ms, 'number');
    assert.strictEqual(helloSpan.status, 'ok');
    assert.strictEqual(helloSpan.language, 'node');
    assert.strictEqual(helloSpan.language_version, process.versions.node);
    assert.strictEqual(helloSpan.w3c_traceparent, inboundHeader, 'inbound traceparent echoed');

    assert.strictEqual(helloSpan.tags.organization_id, 'org-test');
    assert.strictEqual(helloSpan.tags.project_id, 'proj-test');
    assert.deepStrictEqual(helloSpan.tags.http_request, {
      scheme: 'http',
      host: '127.0.0.1',
      uri: '/hello',
      query_string: 'x=1',
      method: 'GET',
      status_code: 200
    });

    assert.ok(Array.isArray(helloSpan.http));
    assert.strictEqual(helloSpan.http.length, 1, 'one outbound call recorded');
    const out = helloSpan.http[0];
    assert.strictEqual(out.method, 'GET');
    assert.strictEqual(out.uri, '/up');
    assert.strictEqual(out.status_code, 200);
    assert.ok(out.url.includes('127.0.0.1:' + upstreamPort + '/up'), 'full outbound url: ' + out.url);
    assert.strictEqual(typeof out.duration, 'number');
    assert.deepStrictEqual(helloSpan.sql, []);
    assert.deepStrictEqual(helloSpan.redis, []);

    // --- trace propagation into the upstream service ------------------------
    const upSpan = await waitFor(
      () => collector.lines.find((l) => l.url_path === '/up'),
      4000,
      '/up span'
    );
    assert.strictEqual(upSpan.trace_id, inboundTrace, 'outbound traceparent injection propagates the trace');
    assert.strictEqual(upSpan.parent_id, helloSpan.span_id, 'upstream span is a child of the /hello span');

    // --- request without traceparent, with manual API -----------------------
    const r2 = await fetch(`http://127.0.0.1:${appPort}/db`);
    assert.strictEqual(r2.status, 200);
    await r2.text();

    const dbSpan = await waitFor(
      () => collector.lines.find((l) => l.url_path === '/db'),
      4000,
      '/db span'
    );

    assert.match(dbSpan.trace_id, HEX32, 'fresh random trace id');
    assert.notStrictEqual(dbSpan.trace_id, inboundTrace);
    assert.strictEqual(dbSpan.parent_id, null);
    assert.strictEqual(dbSpan.w3c_traceparent, undefined, 'no traceparent field without inbound header');
    assert.deepStrictEqual(dbSpan.sql, [{ query: 'SELECT * FROM users WHERE id = ?', duration: 1.25 }]);
    assert.deepStrictEqual(dbSpan.redis, [{ command: 'get', key: 'user:1', duration: 0.4 }]);
    assert.deepStrictEqual(dbSpan.http, []);
    assert.strictEqual(dbSpan.tags.custom_tag, 'yes', 'addTags merged into span tags');

    assert.ok(Array.isArray(dbSpan.stack), 'manual span() produces a stack');
    assert.strictEqual(dbSpan.stack.length, 2, 'root + one child');
    const root = dbSpan.stack[0];
    const child = dbSpan.stack[1];
    assert.strictEqual(root.parent_id, '');
    assert.strictEqual(root.depth, 0);
    assert.strictEqual(root.function, 'GET /db');
    assert.strictEqual(child.function, 'compute');
    assert.strictEqual(child.parent_id, root.call_id);
    assert.strictEqual(child.depth, 1);
    assert.strictEqual(typeof child.duration_ms, 'number');

    // --- every captured line satisfies the base contract ---------------------
    for (const line of collector.lines) {
      assert.strictEqual(line.type, 'span');
      assert.match(line.trace_id, HEX32);
      assert.match(line.span_id, HEX16);
      assert.ok(Array.isArray(line.http) && Array.isArray(line.sql) && Array.isArray(line.redis));
    }
  } finally {
    app.close();
    upstream.close();
    await opa.shutdown();
    collector.server.close();
  }
});

test('manual API is a safe no-op outside a span context', () => {
  assert.strictEqual(opa.span('outside', () => 42), 42);
  opa.recordSql('SELECT 1', 1);
  opa.recordRedis('get', 'k', 1);
  opa.addTags({ a: 1 });
});
