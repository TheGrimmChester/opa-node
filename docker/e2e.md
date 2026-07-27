# End-to-end test against the OPA stack

Run the example app inside the OPA docker network and verify spans land in
ClickHouse and the dashboard.

## 1. Run the example app on the stack network

The Go agent listens for ND-JSON spans on TCP `9090`. Assuming the stack's
docker network is `opa-stack` and the agent container is named `opa-agent`:

```bash
docker run --rm -it \
  --network opa-stack \
  -v "$(pwd)":/app -w /app \
  -e OPA_SOCKET_PATH=opa-agent:9090 \
  -e OPA_SERVICE=node-e2e \
  -e OPA_ORGANIZATION_ID=<your-org-id> \
  -e OPA_PROJECT_ID=<your-project-id> \
  -p 3000:3000 \
  node:20 node example/app.js
```

## 2. Generate traffic

```bash
curl http://localhost:3000/hello
curl http://localhost:3000/db
# distributed-trace check: supply an inbound traceparent
curl -H 'traceparent: 00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' \
  http://localhost:3000/hello
```

## 3. What to check

**ClickHouse** (adjust container/table names to your stack):

```bash
docker exec -it opa-clickhouse clickhouse-client -q \
  "SELECT service, name, status, duration_ms FROM spans WHERE service = 'node-e2e' ORDER BY start_ts DESC LIMIT 10"
```

Expect:

- `GET /hello` spans with one entry in the `http` column (the outbound call to
  the internal downstream server) and `status = 'ok'`.
- `GET /db` spans with one `sql` entry and a two-node `stack`
  (root `GET /db` + child `serialize-users`).
- The traceparent request's span has `trace_id = 'aaaa...'` and
  `parent_id = 'bbbbbbbbbbbbbbbb'`.

**Dashboard**: the `node-e2e` service appears in the service list; opening a
`GET /hello` trace shows the outbound HTTP call; the `GET /db` trace shows the
SQL query and the call tree; `language` is `node`.

## Debugging

- Add `-e OPA_DEBUG=1` to the `docker run` to log transport/instrumentation
  errors to stderr.
- `nc opa-agent 9090` from inside the network to confirm the ingest port is
  reachable; the agent buffers up to 1000 spans and reconnects with backoff if
  it is not.
