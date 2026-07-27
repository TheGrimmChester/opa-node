# opa-node

Zero-dependency Node.js instrumentation agent for the [OPA APM platform](https://github.com/TheGrimmChester).
Plain CommonJS, no build step, Node >= 18.

It auto-instruments inbound HTTP requests (plain `http`, Express, Fastify —
anything built on `http.Server`) and outbound `http`/`https` client calls,
propagates W3C `traceparent` headers, and ships spans to the OPA Go agent as
ND-JSON over TCP.

## Quickstart

```bash
npm install opa-node
```

Load it **before** your framework, as early as possible:

```js
require('opa-node').start();
```

That is all — every inbound request now produces a span, and every outbound
`http.request`/`https.request` made while handling it is attached to that span
with a `traceparent` header injected for distributed tracing.

### Express example

```js
require('opa-node').start(); // first line of the entry file

const opa = require('opa-node');
const express = require('express');
const app = express();

app.get('/users/:id', async (req, res) => {
  const t0 = process.hrtime.bigint();
  const user = await db.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
  opa.recordSql('SELECT * FROM users WHERE id = ?', Number(process.hrtime.bigint() - t0) / 1e6);

  await opa.span('render-profile', async () => {
    res.json(await renderProfile(user));
  });
});

app.listen(3000);
```

## Configuration

`start(options)` arguments take precedence over environment variables.

| Option (`start({...})`) | Env var              | Default                                      | Description                                   |
| ----------------------- | -------------------- | -------------------------------------------- | --------------------------------------------- |
| `enabled`               | `OPA_ENABLED`        | `1`                                          | Disable the agent entirely with `0`/`false`.  |
| `socketPath`            | `OPA_SOCKET_PATH`    | `127.0.0.1:9090`                             | `host:port` of the OPA agent TCP ingest.      |
| `service`               | `OPA_SERVICE`        | app's `package.json` name, else `node-app`   | Service name shown in the dashboard.          |
| `organizationId`        | `OPA_ORGANIZATION_ID`| —                                            | Organization id tag.                          |
| `projectId`             | `OPA_PROJECT_ID`     | —                                            | Project id tag.                               |
| `samplingRate`          | `OPA_SAMPLING_RATE`  | `1`                                          | 0..1, decided per request at span creation.   |
| `debug`                 | `OPA_DEBUG`          | off                                          | Log agent internals to stderr.                |

## API

- `start(options)` — start the agent (idempotent).
- `span(name, fn)` — time a manual sub-operation (`fn` may be sync or return a
  promise); appears in the span's call tree under the request handler.
- `recordSql(query, durationMs)` — attach a SQL query to the active span.
- `recordRedis(command, key, durationMs)` — attach a Redis command.
- `addTags(object)` — merge custom tags into the active span.
- `shutdown()` — flush buffered spans and close the TCP connection
  (returns a promise; call on graceful exit).

## What gets captured

Per inbound request:

- name (`GET /path`, query string stripped), timing (`start_ts`/`end_ts` epoch
  ms, `duration_ms`, best-effort `cpu_ms` from `process.cpuUsage`),
- status (`error` when the response code is >= 500 or the connection aborted),
- request tags (scheme, host, uri, query string, method, status code),
- outbound HTTP calls (url, method, uri, status code, duration) made during the
  request — with `traceparent: 00-<trace_id>-<span_id>-01` injected so
  downstream OPA-instrumented services join the same trace,
- manually recorded SQL/Redis operations and `span()` call-tree nodes,
- W3C trace context: a valid inbound `traceparent` header is adopted (its
  trace-id becomes the span's `trace_id`, its parent-id the span's `parent_id`).

Sampling drops the whole request at creation time; unsampled requests run with
zero instrumentation overhead beyond the sampling check.

## Wire protocol

Spans are sent to the OPA Go agent as **ND-JSON over plain TCP** (default port
`9090`): one JSON object per line, `type: "span"`, 32-hex `trace_id`, 16-hex
`span_id`, plus the operation arrays (`http`, `sql`, `redis`), tags, and an
optional flat `stack` call tree. The transport is fire-and-forget: it connects
lazily, buffers up to 1000 spans while reconnecting (250ms–5s backoff), drops
on overflow, never throws into application code, and never keeps the process
alive (the socket is `unref()`ed).

## Example & tests

```bash
node example/app.js        # demo server on :3000 with /hello and /db routes
npm test                   # or: node test/unit.test.js
```

See [docker/e2e.md](docker/e2e.md) for running the example against a full OPA
stack and verifying spans in ClickHouse and the dashboard.

## License

MIT © TheGrimmChester
