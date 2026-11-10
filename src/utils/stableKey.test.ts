/**
 * Plain-assertion tests for stableKey.ts:
 *
 *   npx tsx src/utils/stableKey.test.ts
 */

import { stableKey } from './stableKey';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

check('key order ignored', stableKey({ a: 1, b: 2 }) === stableKey({ b: 2, a: 1 }));
check('nested key order ignored',
  stableKey({ x: { m: 1, n: [1, { q: 1, p: 2 }] } }) === stableKey({ x: { n: [1, { p: 2, q: 1 }], m: 1 } }));
check('array order matters', stableKey([1, 2]) !== stableKey([2, 1]));
check('values matter', stableKey({ a: 1 }) !== stableKey({ a: 2 }));
check('undefined props dropped like JSON', stableKey({ a: 1, b: undefined }) === stableKey({ a: 1 }));
check('null kept', stableKey({ a: null }) === '{"a":null}');
check('primitives', stableKey(5) === '5' && stableKey('x') === '"x"' && stableKey(null) === 'null');
check('undefined has a key', stableKey(undefined) === 'undefined');

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
