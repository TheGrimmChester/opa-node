'use strict';

/**
 * Wave 13-2: GraphQL / gRPC / CLI helpers (manual + light auto hooks).
 */

const api = require('../api');

function graphqlTags(operationName, operationType) {
  const name = String(operationName || 'anonymous');
  const type = String(operationType || 'query');
  return {
    'graphql.operation.name': name,
    'graphql.operation.type': type,
    graphql_operation: name,
    graphql_operation_type: type
  };
}

function graphqlSpanName(operationName, operationType) {
  return `GraphQL ${operationType || 'query'} ${operationName || 'anonymous'}`;
}

/** Stamp GraphQL identity onto the active span (e.g. from an Apollo plugin). */
function noteGraphql(operationName, operationType) {
  try { api.addTags(graphqlTags(operationName, operationType)); } catch (e) { /* ignore */ }
}

function grpcTags(service, method, system) {
  const svc = String(service || '');
  const m = String(method || '');
  return {
    'rpc.system': system || 'grpc',
    'rpc.service': svc,
    'rpc.method': m,
    rpc_system: system || 'grpc',
    rpc_service: svc,
    rpc_method: m
  };
}

function grpcSpanName(service, method) {
  return `grpc ${service || 'unknown'}/${method || 'unknown'}`;
}

function noteGrpc(service, method, system) {
  try { api.addTags(grpcTags(service, method, system)); } catch (e) { /* ignore */ }
}

/**
 * Bounded CLI/cron transaction name — mirrors PHP cli_naming.c:
 * keep shape, drop values that look like ids.
 */
function cliTransactionName(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  if (!args.length) return 'CLI';
  const base = String(args[0] || '').split(/[/\\]/).pop() || 'cli';
  const launchers = new Set(['node', 'nodejs', 'npm', 'npx', 'yarn', 'pnpm', 'tsx', 'ts-node']);
  let i = 1;
  const parts = [base];
  if (launchers.has(base) && args[1]) {
    const script = String(args[1]).split(/[/\\]/).pop();
    parts.push(script);
    i = 2;
  }
  let kept = 0;
  for (; i < args.length && kept < 3; i++) {
    const a = String(args[i]);
    if (a.startsWith('-')) continue;
    if (/^\d+$/.test(a) || /^[0-9a-f-]{8,}$/i.test(a)) {
      parts.push(':id');
    } else {
      parts.push(a.slice(0, 48));
    }
    kept++;
  }
  return parts.join(' ').slice(0, 256);
}

function noteCli(argv) {
  const name = cliTransactionName(argv || process.argv.slice(1));
  try { api.addTags({ transaction_name: name, cli: true }); } catch (e) { /* ignore */ }
  return name;
}

/** File I/O / serialization helper tags for manual spans. */
function ioTags(kind, path) {
  return {
    'io.kind': kind || 'file',
    'io.path': String(path || '').slice(0, 200),
    io_kind: kind || 'file'
  };
}

module.exports = {
  graphqlTags, graphqlSpanName, noteGraphql,
  grpcTags, grpcSpanName, noteGrpc,
  cliTransactionName, noteCli,
  ioTags
};
