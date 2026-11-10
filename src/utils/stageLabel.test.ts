/**
 * Plain-assertion tests for stageCustomerLabel (types.ts):
 *
 *   npx tsx src/utils/stageLabel.test.ts
 */

import { stageCustomerLabel, DEFAULT_PIPELINE_STAGES, type PipelineStage } from '../types';

let passed = 0;
let failed = 0;
function check(name: string, got: string, want: string) {
  if (got === want) passed++; else { failed++; console.error(`FAIL: ${name} — got "${got}", want "${want}"`); }
}

const base: PipelineStage = { ...DEFAULT_PIPELINE_STAGES[0], name: 'Created', customerLabel: undefined, nameAr: null, customerLabelAr: null };

check('EN: name', stageCustomerLabel(base), 'Created');
check('EN: customer label wins', stageCustomerLabel({ ...base, customerLabel: 'Logged' }), 'Logged');
check('EN: Arabic fields ignored', stageCustomerLabel({ ...base, nameAr: 'تم الإنشاء' }, 'en'), 'Created');
check('AR: Arabic customer label first', stageCustomerLabel({ ...base, nameAr: 'تم الإنشاء', customerLabelAr: 'سُجّلت' }, 'ar'), 'سُجّلت');
check('AR: then Arabic name', stageCustomerLabel({ ...base, nameAr: 'تم الإنشاء' }, 'ar'), 'تم الإنشاء');
check('AR: blank Arabic ignored', stageCustomerLabel({ ...base, nameAr: '  ', customerLabelAr: '' }, 'ar'), 'Created');
check('AR: falls back to English customer label', stageCustomerLabel({ ...base, customerLabel: 'Logged' }, 'ar'), 'Logged');

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
