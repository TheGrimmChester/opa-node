#!/usr/bin/env bash
# Build a minimal Lambda layer zip containing opa-node.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-/tmp/opa-node-layer.zip}"
STAGE="$(mktemp -d)"
mkdir -p "$STAGE/nodejs"
# Prefer packing from the local checkout
cd "$ROOT"
npm pack --pack-destination "$STAGE" --silent >/dev/null
TARBALL="$(ls "$STAGE"/opa-node-*.tgz | head -1)"
mkdir -p "$STAGE/nodejs/node_modules"
tar -xzf "$TARBALL" -C "$STAGE/nodejs/node_modules"
mv "$STAGE/nodejs/node_modules/package" "$STAGE/nodejs/node_modules/opa-node"
(cd "$STAGE" && zip -qr "$OUT" nodejs)
rm -rf "$STAGE"
echo "Wrote $OUT"
