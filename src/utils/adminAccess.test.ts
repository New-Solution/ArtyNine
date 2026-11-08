/**
 * Plain-assertion tests for the Data Reset gate in adminAccess.ts. No test
 * framework — same style as captcha.test.ts:
 *
 *   npx tsx src/utils/adminAccess.test.ts
 */

import { canSeeSettingsSection, isDataResetConfirmed, DATA_RESET_PHRASE } from './adminAccess';

let passed = 0;
let failed = 0;

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const superAdmin = { role: 'Super Admin' } as any;
const admin = { role: 'Admin' } as any;
const staff = { role: 'Staff' } as any;

console.log('canSeeSettingsSection() — Data Reset is Super Admin only');
assertEqual(canSeeSettingsSection('settings-data-reset', superAdmin), true, 'Super Admin sees Data Reset');
assertEqual(canSeeSettingsSection('settings-data-reset', admin), false, 'Admin does not');
assertEqual(canSeeSettingsSection('settings-data-reset', staff), false, 'Staff does not');
assertEqual(canSeeSettingsSection('settings-data-reset', null), false, 'nobody signed in does not');
assertEqual(canSeeSettingsSection('settings-payments', admin), true, 'other sections unchanged');

console.log('isDataResetConfirmed() — exact phrase only');
assertEqual(DATA_RESET_PHRASE, 'DELETE EVERYTHING', 'the phrase');
assertEqual(isDataResetConfirmed('DELETE EVERYTHING'), true, 'exact phrase');
assertEqual(isDataResetConfirmed('  DELETE EVERYTHING  '), true, 'surrounding spaces ignored');
assertEqual(isDataResetConfirmed('delete everything'), false, 'lower case refused');
assertEqual(isDataResetConfirmed('DELETE'), false, 'partial refused');
assertEqual(isDataResetConfirmed('DELETE  EVERYTHING'), false, 'double space refused');
assertEqual(isDataResetConfirmed(''), false, 'empty refused');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
