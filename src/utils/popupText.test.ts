/**
 * Plain-assertion tests for popupTextForLang / migratePrePaymentPopup (types.ts):
 *
 *   npx tsx src/utils/popupText.test.ts
 */

import { popupTextForLang, migratePrePaymentPopup, DEFAULT_PREPAYMENT_POPUP } from '../types';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) passed++; else { failed++; console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

// English is the stored text.
{
  const en = popupTextForLang(DEFAULT_PREPAYMENT_POPUP, 'en');
  check('EN title', en.title === DEFAULT_PREPAYMENT_POPUP.title);
  check('EN instructions', en.instructions.length === DEFAULT_PREPAYMENT_POPUP.instructions.length);
}

// Arabic, nothing typed: built-in translation of the shipped defaults.
{
  const ar = popupTextForLang(DEFAULT_PREPAYMENT_POPUP, 'ar');
  check('AR default title translated', ar.title === 'تعليمات مهمة للسلامة والجدول الزمني في الاستوديو', ar.title);
  check('AR default button translated', ar.buttonLabel === 'المتابعة إلى الدفع', ar.buttonLabel);
  check('AR default instructions translated', ar.instructions.every(l => /[؀-ۿ]/.test(l)));
}

// Arabic, English edited, no Arabic typed: the English as typed.
{
  const cfg = { ...DEFAULT_PREPAYMENT_POPUP, title: 'Read before paying' };
  check('AR falls back to edited English', popupTextForLang(cfg, 'ar').title === 'Read before paying');
}

// Arabic typed in Settings wins, field by field.
{
  const cfg = {
    ...DEFAULT_PREPAYMENT_POPUP,
    titleAr: 'اقرأ قبل الدفع',
    messageAr: 'فقرة أولى\n\nفقرة ثانية',
    instructionsAr: ['تعليمة', '   '],
    buttonLabelAr: '',
    checkboxLabelAr: 'أوافق'
  };
  const ar = popupTextForLang(cfg, 'ar');
  check('AR title typed', ar.title === 'اقرأ قبل الدفع');
  check('AR message paragraphs', ar.paragraphs.length === 2 && ar.paragraphs[1] === 'فقرة ثانية', JSON.stringify(ar.paragraphs));
  check('AR instructions replace the list, blanks dropped', ar.instructions.length === 1 && ar.instructions[0] === 'تعليمة');
  check('AR empty button falls back to translation', ar.buttonLabel === 'المتابعة إلى الدفع', ar.buttonLabel);
  check('AR checkbox typed', ar.checkboxLabel === 'أوافق');
  check('EN unaffected by Arabic fields', popupTextForLang(cfg, 'en').title === DEFAULT_PREPAYMENT_POPUP.title);
}

// Migration keeps Arabic fields and does not invent them.
{
  const kept = migratePrePaymentPopup({ ...DEFAULT_PREPAYMENT_POPUP, titleAr: 'ع', instructionsAr: ['أ', '', 3] });
  check('migrate keeps titleAr', kept.titleAr === 'ع');
  check('migrate cleans instructionsAr', JSON.stringify(kept.instructionsAr) === '["أ"]', JSON.stringify(kept.instructionsAr));
  const plain = migratePrePaymentPopup({ title: 'x' });
  check('migrate adds no Arabic keys to an English-only record',
    !('titleAr' in plain) && !('messageAr' in plain) && !('instructionsAr' in plain));
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
