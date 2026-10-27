/**
 * Plain-assertion tests for pipelineStages.ts. No test framework — same style
 * as phoneAuth.test.ts:
 *
 *   npx tsx src/utils/pipelineStages.test.ts
 */

import { stageOf, stageByKey, isEndState } from './pipelineStages';
import type { PipelineStage } from '../types';

let passed = 0;
let failed = 0;

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ok — ${label}`);
  } else {
    failed++;
    console.error(`  FAIL — ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}

/** The five production rows after 0045, plus one custom stage. */
const STAGES: PipelineStage[] = [
  { id: 'stage-greenware', name: 'Created', color: '', order: 0, visibleToCustomer: true, systemKey: 'created' },
  { id: 'stage-bisque', name: 'First Burn and Colored', color: '', order: 1, visibleToCustomer: true, systemKey: 'kiln' },
  { id: 'stage-custom', name: 'Glaze Drying', color: '', order: 2, visibleToCustomer: false, systemKey: null },
  { id: 'stage-ready', name: 'Ready for Pickup', color: '', order: 3, visibleToCustomer: true, systemKey: 'ready' },
  { id: 'stage-collected', name: 'Collected', color: '', order: 4, visibleToCustomer: false, systemKey: 'collected' },
  { id: 'stage-broken', name: 'Broken', color: '', order: 5, visibleToCustomer: false, systemKey: 'broken' }
];
const idOf = (s: PipelineStage | undefined) => s?.id ?? null;

console.log('stageOf()');
assertEqual(idOf(stageOf({ stageId: 'stage-ready', status: 'Ready for Pickup' }, STAGES)), 'stage-ready', 'by stage id');
assertEqual(idOf(stageOf({ stageId: 'stage-bisque', status: 'Created' }, STAGES)), 'stage-bisque', 'stage id wins over a disagreeing name');
assertEqual(idOf(stageOf({ stageId: 'stage-custom', status: 'Glaze Drying' }, STAGES)), 'stage-custom', 'a custom stage by id');
assertEqual(
  idOf(stageOf({ stageId: 'stage-bisque', status: 'Kiln Time' }, [{ ...STAGES[1], name: 'Kiln Time' }])),
  'stage-bisque',
  'a renamed stage is still found by id'
);
assertEqual(idOf(stageOf({ status: 'First Burn and Colored' }, STAGES)), 'stage-bisque', 'no stage id: by exact name');
assertEqual(idOf(stageOf({ stageId: null, status: 'Collected' }, STAGES)), 'stage-collected', 'null stage id: by exact name');
assertEqual(idOf(stageOf({ stageId: 'stage-gone', status: 'Broken' }, STAGES)), 'stage-broken', 'unknown stage id: falls back to the name');
assertEqual(idOf(stageOf({ status: 'Glazing' }, STAGES)), 'stage-bisque', 'retired name: mapped like migrateLegacyPieceStatus');
assertEqual(idOf(stageOf({ status: 'Ready for Collection' }, STAGES)), 'stage-ready', 'retired name: Ready for Collection');
assertEqual(idOf(stageOf({ status: 'Something Else' }, STAGES)), 'stage-greenware', 'unrecognised name: Created, as migrateLegacyPieceStatus does');
assertEqual(idOf(stageOf({}, STAGES)), 'stage-greenware', 'no status at all: Created');
assertEqual(idOf(stageOf({ status: 'Created' }, [])), null, 'empty stage list: undefined');

console.log('stageByKey()');
assertEqual(idOf(stageByKey(STAGES, 'kiln')), 'stage-bisque', 'kiln');
assertEqual(idOf(stageByKey(STAGES, 'ready')), 'stage-ready', 'ready');
assertEqual(idOf(stageByKey(STAGES.filter(s => s.systemKey !== 'broken'), 'broken')), null, 'missing key: undefined');

console.log('isEndState()');
assertEqual(STAGES.filter(isEndState).map(s => s.id), ['stage-collected', 'stage-broken'], 'only Collected and Broken');
assertEqual(isEndState(undefined), false, 'undefined stage: not an end-state');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
