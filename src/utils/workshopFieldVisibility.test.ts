/**
 * Plain-assertion tests for isBuiltInFieldCustomerVisible (types.ts):
 *
 *   npx tsx src/utils/workshopFieldVisibility.test.ts
 *
 * The customer workshop page shows Duration, Ages, Tutor and Location only
 * when their built-in field is enabled and marked "Visible to Customers".
 */

import { isBuiltInFieldCustomerVisible, DEFAULT_WORKSHOP_FIELDS, type WorkshopFieldConfig } from '../types';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) passed++; else { failed++; console.error(`FAIL: ${name}`); }
}

const D = DEFAULT_WORKSHOP_FIELDS;
check('default: Duration visible', isBuiltInFieldCustomerVisible(D, 'duration'));
check('default: Ages visible', isBuiltInFieldCustomerVisible(D, 'ageRange'));
check('default: Tutor visible', isBuiltInFieldCustomerVisible(D, 'staffId'));
check('default: Studio Room / Location visible', isBuiltInFieldCustomerVisible(D, 'roomId'));

const set = (boundTo: string, patch: Partial<WorkshopFieldConfig>) =>
  D.map(f => (f.boundTo === boundTo ? { ...f, ...patch } : f));
check('Room toggled staff-only', !isBuiltInFieldCustomerVisible(set('roomId', { customerVisible: false }), 'roomId'));
check('Tutor toggled staff-only', !isBuiltInFieldCustomerVisible(set('staffId', { customerVisible: false }), 'staffId'));
check('disabled field hidden even if visible', !isBuiltInFieldCustomerVisible(set('duration', { enabled: false }), 'duration'));
check('unconfigured field stays visible', isBuiltInFieldCustomerVisible([], 'duration'));
check('missing flags count as visible',
  isBuiltInFieldCustomerVisible([{ ...D.find(f => f.boundTo === 'ageRange')!, customerVisible: undefined as unknown as boolean }], 'ageRange'));

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
