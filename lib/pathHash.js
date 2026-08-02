'use strict';

/**
 * Call-graph call-path identity — frozen cross-runtime contract.
 *
 * path_hash = FNV-1a 64 of the root→node chain of frame names, joined by LF.
 * Frame name = class ? (class + "::" + function) : function
 *             (empty function → "<unknown>")
 * call_site = caller's "file:line" ("" when unknown / root)
 *
 * Join key for compare/rollup: (path_hash, call_site).
 */

const FNV_OFFSET = 0xCBF29CE484222325n;
const FNV_PRIME = 0x100000001B3n;

function fnv1a64Hex(str) {
  let h = FNV_OFFSET;
  const buf = Buffer.from(String(str), 'utf8');
  for (let i = 0; i < buf.length; i++) {
    h ^= BigInt(buf[i]);
    h = (h * FNV_PRIME) & 0xFFFFFFFFFFFFFFFFn;
  }
  return h.toString(16).padStart(16, '0');
}

function frameName(node) {
  const fn = (node && node.function) ? String(node.function) : '<unknown>';
  const cls = node && node.class ? String(node.class) : '';
  return cls ? (cls + '::' + fn) : fn;
}

/**
 * @param {Array<{call_id?:string,parent_id?:string,function?:string,class?:string}>} nodes
 * @param {object} node
 * @returns {string} 16 lowercase hex digits
 */
function pathHashForNode(nodes, node) {
  const byId = new Map();
  for (const n of nodes) {
    if (n && n.call_id) byId.set(n.call_id, n);
  }
  const chain = [];
  let cur = node;
  const seen = new Set();
  while (cur && !seen.has(cur.call_id)) {
    chain.push(frameName(cur));
    seen.add(cur.call_id);
    const pid = cur.parent_id;
    cur = pid ? byId.get(pid) : null;
  }
  chain.reverse();
  return fnv1a64Hex(chain.join('\n'));
}

/**
 * Attach path_hash (+ keep call_site) on every node of a flat stack.
 * @param {Array<object>} stack
 * @returns {Array<object>}
 */
function annotateStack(stack) {
  if (!Array.isArray(stack)) return stack;
  return stack.map((node) => Object.assign({}, node, {
    path_hash: pathHashForNode(stack, node),
    call_site: node.call_site != null ? String(node.call_site) : ''
  }));
}

module.exports = { fnv1a64Hex, frameName, pathHashForNode, annotateStack };
