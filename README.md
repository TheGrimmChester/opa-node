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

## Outbound calls

Both HTTP clients are instrumented, and each outbound call carries a W3C
`traceparent` header so the downstream service continues the same trace:

- **`http.request` / `https.request`** (and libraries built on them, e.g.
  axios's Node adapter)
- **the global `fetch()`** (undici) — the default client on Node ≥ 18. A
  `traceparent` you set yourself is never overwritten.

## Route templates

Spans are named after the framework's route template when one is available, so
parameterized routes aggregate as one endpoint:

| Framework | Source | Span name |
|---|---|---|
| Express | `req.baseUrl` + `req.route.path` | `GET /users/:id` |
| Fastify | `req.routeOptions.url` (v4+) or `req.routerPath` | `GET /items/:sku` |
| plain `http` | concrete path | `GET /plain/path` |

The concrete path stays on the span as `url_path`, so drill-downs and filters
still target individual requests.

## Database & cache calls

`pg`, `mysql2` and `ioredis` are instrumented automatically. None of them is a
dependency of this package — each is patched only if your app already has it
installed, and skipped silently otherwise:

| Module | Patched | Recorded on the span |
|---|---|---|
| `pg` | `Client.prototype.query`, `Pool.prototype.query` | `sql[]` — statement text + duration |
| `mysql2` (incl. `mysql2/promise`) | `Connection.prototype.query` / `.execute` | `sql[]` — statement text + duration |
| `ioredis` | `Redis.prototype.sendCommand` | `redis[]` — command, first key, duration |

Promise and callback styles are both handled. Calls made outside a request
(no active span) pass straight through untouched. `opa.recordSql()` /
`opa.recordRedis()` remain available for anything not covered.

## Logs

`opa.log()` ships a structured log line over the same socket as spans, so it
lands on the dashboard's **Logs** page — and when called during a request it
carries that trace id, so the log links to the trace that produced it:

```js
opa.logInfo('order placed', { order_id: 'A-1', total: 42.5 })
opa.logWarn('retrying payment', { attempt: 2 })
opa.logError('checkout failed', { order_id: 'A-1' })
opa.log('DEBUG', 'cache miss', { key: 'user:42' })   // any level
```

Safe to call before `start()`, after `shutdown()`, or with the agent disabled —
it simply does nothing.

## Limitations

- Outbound calls made by clients that bypass both `http.request` and global
  `fetch` (a raw socket protocol, or a native addon) are not captured.

## Example & tests

```bash
node example/app.js        # demo server on :3000 with /hello and /db routes
npm test                   # or: node test/unit.test.js
```

See [docker/e2e.md](docker/e2e.md) for running the example against a full OPA
stack and verifying spans in ClickHouse and the dashboard.

## Runtime metrics

Enabled by default. Reported every 15s on the same socket as spans, as a
`type:"metric"` batch — no new port or protocol.

```js
opa.start({ runtimeMetrics: false })            // opt out
opa.start({ runtimeMetricsIntervalMs: 30000 })  // or slow it down
```
`OPA_RUNTIME_METRICS=0` and `OPA_RUNTIME_METRICS_INTERVAL_MS` do the same.

**Every number here is unreachable from outside the process.** A host collector sees
a Node process using 400 MB and one core; it cannot see that the event loop is
800 ms behind, that old-space is nearly full with GC running continuously, or that
the app is holding 40,000 sockets open. Those are what explain a Node service whose
spans all look fine while requests queue.

| Metric | Why it matters |
|---|---|
| `nodejs.eventloop.delay{quantile}` · `.max` | A blocked loop makes requests *wait before your handler runs*. The span times the handler, so it records a fast request while the user waited. Nothing else shows this. |
| `nodejs.eventloop.utilization` | Fraction of wall time the loop spent working. Unlike CPU%, it is specific to the loop, so ≈1 means the loop is the bottleneck even on an idle-looking host. |
| `nodejs.heap.utilization` · `.used` · `.limit` | OOM is measured against `heap_size_limit`, so this ratio is what predicts a crash. |
| `nodejs.heap.space.used{space}` | Where a leak becomes legible: `old_space` growing while `new_space` is flat is retention, not churn. |
| `nodejs.heap.external` · `.malloced` · `process.memory.array_buffers` | Node is frequently killed for memory *outside* the JS heap — Buffers live there, so a heap graph alone cannot explain the OOM. |
| `nodejs.gc.collections{kind}` · `.duration{kind}` | A scavenge storm and a run of mark-sweeps are different problems: allocation churn vs retention pressure. |
| `nodejs.active_resources{resource_type}` | A steadily climbing count is leaked sockets, timers or handles — invisible to any host metric. |

**Delay has a floor.** `monitorEventLoopDelay` samples at 20 ms resolution, so a
perfectly idle loop reports ≈20 ms. Alert on the *change*, not the absolute value;
a real stall is unmistakable (a 300 ms block shows as `delay.max` ≈307 ms).

GC is typed `delta`, not `counter`: it is accumulated since the last report and then
cleared, so each point is a change over an interval. Declaring it a cumulative
counter would make every rate derived from it wrong.

The reporter's timer is `unref()`d — a monitoring agent must never change the
lifetime of the process it monitors.

## License

MIT © TheGrimmChester
