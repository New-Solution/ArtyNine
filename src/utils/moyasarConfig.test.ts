/**
 * Plain-assertion tests for moyasarConfig.ts. No test framework — same style
 * as onlinePayments.test.ts:
 *
 *   npx tsx src/utils/moyasarConfig.test.ts
 *
 * Guards the live failure where apple_pay.label 'Arty Café' made Moyasar.js
 * replace the whole payment form with "Form configuration issue!".
 */

import {
  PRINTABLE_ASCII,
  isPrintableAscii,
  MOYASAR_APPLE_PAY,
  moyasarDescription,
  moyasarConfigProblem
} from './moyasarConfig';

let passed = 0;
let failed = 0;

function assertEqual<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}: expected ${e}, got ${a}`);
  }
}

console.log('the labels we send are ASCII only');
assertEqual(MOYASAR_APPLE_PAY.label, 'Arty Cafe', 'Apple Pay label is plain ASCII "Arty Cafe"');
assertEqual(PRINTABLE_ASCII.test(MOYASAR_APPLE_PAY.label), true, 'Apple Pay label passes Moyasar\'s /^[\\x20-\\x7E]+$/');
assertEqual(isPrintableAscii(MOYASAR_APPLE_PAY.country), true, 'Apple Pay country is ASCII');
assertEqual(isPrintableAscii(moyasarDescription('ART-1234567')), true, 'description is ASCII');
assertEqual(moyasarDescription('ART-1234567'), 'Arty booking ART-1234567', 'description from the booking id');
assertEqual(
  moyasarConfigProblem({ description: moyasarDescription('ART-1234567'), apple_pay: MOYASAR_APPLE_PAY }),
  null,
  'the config the panel sends has no problem'
);

console.log('what Moyasar would reject is caught first');
assertEqual(isPrintableAscii('Arty Café'), false, '"Arty Café" rejected (the live bug)');
assertEqual(isPrintableAscii('ورشة عجلة الفخار'), false, 'Arabic rejected');
assertEqual(isPrintableAscii('   '), false, 'blank rejected');
assertEqual(isPrintableAscii(undefined), false, 'missing rejected');
assertEqual(moyasarConfigProblem({ description: 'Arty booking ART-1', apple_pay: { label: 'Arty Café', country: 'SA' } }) !== null, true, 'accented label -> problem');
assertEqual(moyasarConfigProblem({ description: 'حجز', apple_pay: MOYASAR_APPLE_PAY }) !== null, true, 'Arabic description -> problem');
assertEqual(moyasarConfigProblem({ description: 'Arty booking ART-1', apple_pay: { label: 'Arty Cafe', country: 'sau' } }) !== null, true, 'bad country -> problem');
assertEqual(moyasarConfigProblem({ description: 'Arty booking ART-1' }), null, 'no apple_pay: only description checked');

console.log('description stays ASCII whatever the id');
assertEqual(moyasarDescription('ART-١٢٣'), 'Arty booking ART-', 'non-ASCII digits dropped');
assertEqual(moyasarDescription(''), 'Arty booking', 'empty id -> plain description');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
