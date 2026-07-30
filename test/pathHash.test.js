'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { fnv1a64Hex, pathHashForNode, annotateStack } = require('../lib/pathHash');

test('fnv1a64Hex matches frozen golden vectors', () => {
  assert.strictEqual(fnv1a64Hex('leaf_once'), '63ffcf1c2924be1b');
  assert.strictEqual(fnv1a64Hex('caller_loop\nleaf_once'), 'fef2201c3030087b');
  assert.strictEqual(fnv1a64Hex('parent_sleep\nchild_sleep'), '687112338dbc53e5');
  assert.strictEqual(fnv1a64Hex('Foo::bar'), '96d17de6777c1988');
  assert.strictEqual(fnv1a64Hex('A::a\nB::b\nC::c'), '09ea434f50c074b5');
});

test('pathHashForNode walks parent_id root→leaf', () => {
  const stack = [
    { call_id: 'c0', parent_id: '', function: 'A::a', class: '' },
    { call_id: 'c1', parent_id: 'c0', function: 'b', class: 'B' },
    { call_id: 'c2', parent_id: 'c1', function: 'c', class: 'C' }
  ];
  // Fix frame names: class+function — set properly
  stack[0] = { call_id: 'c0', parent_id: '', function: 'a', class: 'A' };
  stack[1] = { call_id: 'c1', parent_id: 'c0', function: 'b', class: 'B' };
  stack[2] = { call_id: 'c2', parent_id: 'c1', function: 'c', class: 'C' };
  assert.strictEqual(pathHashForNode(stack, stack[2]), '09ea434f50c074b5');
  const annotated = annotateStack(stack);
  assert.strictEqual(annotated[2].path_hash, '09ea434f50c074b5');
  assert.strictEqual(annotated[2].call_site, '');
});
