# Serverless / FaaS packaging

## Lifecycle-safe transport (18-1)

Serverless freezes the process between invocations. Flush **before return**, with a
bounded deadline (`OPA_SERVERLESS_FLUSH_MS`, default 400ms), not at process exit.

Preferred path when TCP may not complete in time:

```bash
export OPA_HTTP_INGEST_URL=https://opa-agent.example:8080
# SDKs POST queued ND-JSON to POST /v1/ndjson
```

## Node (opa-node)

```js
const opa = require('opa-node')
opa.start({ service: 'checkout-fn', httpIngestURL: process.env.OPA_HTTP_INGEST_URL })
exports.handler = opa.wrapLambdaHandler(async (event, context) => {
  // ...
})
```

### Lambda layer sketch

```text
nodejs/
  node_modules/opa-node/...
```

Build with `packaging/lambda/node/build-layer.sh` (this repo).

## Python (opa-python)

```python
import opa_apm as opa
opa.start(service="checkout-fn")
handler = opa.wrap_lambda_handler(opa._agent, my_handler)
```

Layer: ship `opa_apm` under `python/` in the layer zip.

## PHP extension

Ship a custom Lambda layer containing the `.so` built for Amazon Linux 2/2023 + PHP
version matching your runtime. Set `opa.transport` to TCP/HTTP toward the agent and
ensure request-end flush (`opa` already flushes on RSHUTDOWN — still prefer short
invocations and an HTTP ingest sidecar when the runtime freezes early).

See `docs/serverless.md` in OPA-Agent for APIs (cold start, cost).
