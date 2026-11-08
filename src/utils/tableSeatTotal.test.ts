/**
 * Plain-assertion tests for tableSeatTotal / summarizeTableCapacity:
 *
 *   npx tsx src/utils/tableSeatTotal.test.ts
 *
 * The seat total counts Active tables only, and Settings -> Capacity, the
 * Live Queue header and the Table Inventory all use this one function.
 */

import { tableSeatTotal, computeTableStates, summarizeTableCapacity } from './tableSeatingUtils';
import type { StudioTableConfig } from '../types';

let passed = 0;
let failed = 0;
function check(name: string, got: number, want: number) {
  if (got === want) passed++; else { failed++; console.error(`FAIL: ${name} — got ${got}, want ${want}`); }
}

const tables: StudioTableConfig[] = [
  { id: 't1', number: 1, name: 'T1', seats: 4, status: 'Active' },
  { id: 't2', number: 2, name: 'T2', seats: 6, status: 'Active' },
  { id: 't3', number: 3, name: 'T3', seats: 4, status: 'Inactive' },
  { id: 't4', number: 4, name: 'T4', seats: 8, status: 'Maintenance' }
];

check('active tables only', tableSeatTotal(tables), 10);
check('no tables', tableSeatTotal([]), 0);
check('string seats counted', tableSeatTotal([{ seats: '5', status: 'Active' }]), 5);
check('missing seats count as 0', tableSeatTotal([{ status: 'Active' }]), 0);
check('no active tables', tableSeatTotal([{ seats: 4, status: 'Inactive' }]), 0);

// The Table Inventory summary uses the same rule.
const summary = summarizeTableCapacity(computeTableStates(tables, []));
check('inventory total matches', summary.totalSeats, tableSeatTotal(tables));
check('inventory still lists every table', summary.totalTables, 4);

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
