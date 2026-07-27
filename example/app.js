'use strict';

// Minimal demo app for the opa-node agent (no framework, no dependencies).
//
// Run with:
//   OPA_SERVICE=demo-node OPA_SOCKET_PATH=127.0.0.1:9090 \
//   OPA_ORGANIZATION_ID=my-org OPA_PROJECT_ID=my-project \
//   node example/app.js
//
// In a real application: require('opa-node').start();
const opa = require('../lib/index').start();

const http = require('http');

// A tiny internal "downstream service" so /hello can demonstrate the
// outbound http client instrumentation without leaving the machine.
const downstream = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ pong: true, traceparent: req.headers.traceparent || null }));
});

downstream.listen(0, '127.0.0.1', () => {
  const downstreamPort = downstream.address().port;

  const app = http.createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];

    if (path === '/hello') {
      // Outbound call: captured via the http client patch, traceparent injected.
      http.get('http://127.0.0.1:' + downstreamPort + '/ping', (r) => {
        let body = '';
        r.on('data', (c) => { body += c; });
        r.on('end', () => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ hello: 'world', downstream: JSON.parse(body) }));
        });
      });
      return;
    }

    if (path === '/db') {
      // Manual API: record a (simulated) SQL query and a timed sub-operation.
      const start = process.hrtime.bigint();
      // ... run your real query here ...
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6 + 3.2;
      opa.recordSql('SELECT id, email FROM users WHERE active = 1', elapsedMs);

      opa.span('serialize-users', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ users: [{ id: 1, email: 'a@example.com' }] }));
      });
      return;
    }

    res.statusCode = 404;
    res.end('not found (try /hello or /db)\n');
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log('demo app listening on http://localhost:' + port + '  (routes: /hello, /db)');
  });
});

process.on('SIGINT', async () => {
  await opa.shutdown();
  process.exit(0);
});
