/**
 * Pins every customer piece text, byte for byte. Each SMS body must match a
 * template registered with meertek, and notificationText.ts renders stored bell
 * rows in Arabic only when they rebuild exactly — so any change here is a
 * change to what customers receive and must be re-registered first.
 * No test framework — same style as phoneAuth.test.ts:
 *
 *   npx tsx src/utils/pieceSmsTemplates.test.ts
 */

import { pieceStatusText, pieceTextForKey, bilingualSms, KILN_TEXTS, PICKUP_REMINDER_TEXT } from './pieceSmsTemplates';
import { customerPieceTitle, staffPieceTitle } from './pieceNotifications';
import { localizeNotification } from './notificationText';
import { localizeStaffNotification } from './staffNotificationText';
import type { StageSystemKey } from '../types';

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

const G_EN = 'Dear Arty artist,\n';
const G_AR = 'عزيزنا فنان Arty،\n';

/** The exact texts, as registered. */
const PINNED = {
  created: {
    en: G_EN + 'Thank you for visiting us! 🤍 We hope you had a wonderful time and enjoyed your pottery experience!\nYour pottery piece is now resting on our shelf to dry. It should be ready for pickup in approximately two weeks. 🏺✨',
    ar: G_AR + 'شكرًا لزيارتكم لنا! 🤍 نتمنى إنكم استمتعتوا بوقتكم وكانت تجربة الفخار جميلة وممتعة!\nقطعتكم الفخار الآن على الرف عشان تنشف، ومتوقع تكون جاهزة للاستلام خلال أسبوعين تقريبًا. 🏺✨'
  },
  kilnColor: {
    en: G_EN + 'Exciting update! 🔥 Your pottery piece has finished its first firing and is ready for you to color! Come by the café whenever suits you to paint it. 🎨🤍',
    ar: G_AR + 'عندنا لكم تحديث حلو! 🔥 قطعتكم الفخار خلصت أول مرحلة حرق وصارت جاهزة للتلوين! تقدروا تزورونا بأي وقت يناسبكم عشان تلونوها. 🎨🤍'
  },
  kilnKiln: {
    en: G_EN + 'Exciting update! 🔥 Your pottery piece is now in the kiln, getting one step closer to being ready! 🤍',
    ar: G_AR + 'عندنا لكم تحديث حلو! 🔥 قطعتكم الفخار الآن داخل الفرن، وقربت خطوة أكثر إنها تكون جاهزة! 🤍'
  },
  ready: {
    en: G_EN + "Great news! 🎉 Your pottery piece has finished firing and is now ready for pickup! We can't wait for you to see your creation! 🤍🏺",
    ar: G_AR + 'عندنا لكم خبر حلو! 🎉 قطعتكم الفخار خلصت مرحلة الحرق وصارت جاهزة للاستلام! متحمسين تشوفوا إبداعكم 🤍🏺'
  },
  collected: {
    en: G_EN + "Thank you for picking up your pottery piece! 🤍 We hope you loved making it, and we can't wait to see you again soon! 🏺",
    ar: G_AR + 'شكرًا لاستلامكم قطعتكم الفخار! 🤍 نتمنى إنكم استمتعتوا بصنعها، ومتحمسين نشوفكم مرة ثانية قريب! 🏺'
  },
  brokenAC1806: {
    en: G_EN + "We're so sorry 🤍 Unfortunately, your pottery piece AC-1806 was damaged during the process. Please contact us so we can arrange a replacement for you.",
    ar: G_AR + 'نعتذر منكم كثير 🤍 للأسف قطعتكم الفخار AC-1806 تضررت أثناء المراحل. نرجو تتواصلوا معنا عشان نرتب لكم بديل.'
  },
  pickupReminder: {
    en: G_EN + 'Just a friendly reminder 🤍 Your pottery piece is ready and waiting for you on our shelf! Drop by the café whenever suits you to pick it up. 🏺',
    ar: G_AR + 'تذكير بسيط 🤍 قطعتكم الفخار جاهزة وتنتظركم على الرف! تقدروا تمرّون علينا بأي وقت يناسبكم لاستلامها. 🏺'
  }
};

console.log('pieceStatusText() by stored name (also what notificationText.ts matches stored rows with)');
assertEqual(pieceStatusText('Created', 'AC-1806'), PINNED.created, 'Created');
assertEqual(pieceStatusText('First Burn and Colored', 'AC-1806'), PINNED.kilnKiln, 'First Burn and Colored, default variant = kiln');
assertEqual(pieceStatusText('First Burn and Colored', 'AC-1806', 'kiln'), PINNED.kilnKiln, 'First Burn and Colored, kiln');
assertEqual(pieceStatusText('First Burn and Colored', 'AC-1806', 'color'), PINNED.kilnColor, 'First Burn and Colored, color');
assertEqual(pieceStatusText('Ready for Pickup', 'AC-1806'), PINNED.ready, 'Ready for Pickup');
assertEqual(pieceStatusText('Collected', 'AC-1806'), PINNED.collected, 'Collected');
assertEqual(pieceStatusText('Broken', 'AC-1806'), PINNED.brokenAC1806, 'Broken, with the code');
assertEqual(pieceStatusText('Glaze Drying', 'AC-1806'), null, 'a custom stage name: no template');
assertEqual(KILN_TEXTS, { color: PINNED.kilnColor, kiln: PINNED.kilnKiln }, 'KILN_TEXTS: exactly the two variants');
assertEqual(PICKUP_REMINDER_TEXT, PINNED.pickupReminder, 'pickup reminder');

console.log('pieceTextForKey() — what new notifications and SMS are built from');
assertEqual(pieceTextForKey('created', 'AC-1806'), PINNED.created, 'created');
assertEqual(pieceTextForKey('kiln', 'AC-1806'), PINNED.kilnKiln, 'kiln, default variant = kiln');
assertEqual(pieceTextForKey('kiln', 'AC-1806', 'kiln'), PINNED.kilnKiln, 'kiln, kiln');
assertEqual(pieceTextForKey('kiln', 'AC-1806', 'color'), PINNED.kilnColor, 'kiln, color');
assertEqual(pieceTextForKey('ready', 'AC-1806'), PINNED.ready, 'ready');
assertEqual(pieceTextForKey('collected', 'AC-1806'), PINNED.collected, 'collected');
assertEqual(pieceTextForKey('broken', 'AC-1806'), PINNED.brokenAC1806, 'broken, with the code');
assertEqual(pieceTextForKey(null, 'AC-1806'), null, 'custom stage (null key): no template, so no SMS');
assertEqual(pieceTextForKey(undefined, 'AC-1806'), null, 'unknown stage: no template');

console.log('bilingualSms() — English, blank line, Arabic: the exact SMS bodies');
assertEqual(bilingualSms(PINNED.ready), `${PINNED.ready.en}\n\n${PINNED.ready.ar}`, 'layout');
for (const [label, key, variant, pinned] of [
  ['created', 'created', undefined, PINNED.created],
  ['kiln (kiln)', 'kiln', 'kiln', PINNED.kilnKiln],
  ['kiln (color)', 'kiln', 'color', PINNED.kilnColor],
  ['ready', 'ready', undefined, PINNED.ready],
  ['collected', 'collected', undefined, PINNED.collected],
  ['broken', 'broken', undefined, PINNED.brokenAC1806]
] as const) {
  assertEqual(bilingualSms(pieceTextForKey(key, 'AC-1806', variant)!), `${pinned.en}\n\n${pinned.ar}`, `SMS body: ${label}`);
}

// The stage names as stored today, per key — what the bell title and staff
// message are built from.
const NAMES: Record<StageSystemKey, string> = {
  created: 'Created', kiln: 'First Burn and Colored', ready: 'Ready for Pickup', collected: 'Collected', broken: 'Broken'
};

console.log('customerPieceTitle() — stored bell titles');
assertEqual(customerPieceTitle('created', 'AC-1806', NAMES.created), 'Piece Status Update: Created', 'created');
assertEqual(customerPieceTitle('kiln', 'AC-1806', NAMES.kiln), 'Piece Status Update: Kiln Time', 'kiln (display label)');
assertEqual(customerPieceTitle('ready', 'AC-1806', NAMES.ready), 'Piece Ready for Pickup!', 'ready');
assertEqual(customerPieceTitle('collected', 'AC-1806', NAMES.collected), 'Piece Status Update: Collected', 'collected');
assertEqual(customerPieceTitle('broken', 'AC-1806', NAMES.broken), 'Piece AC-1806 marked as broken', 'broken');
assertEqual(customerPieceTitle(null, 'AC-1806', 'Glaze Drying'), 'Piece Status Update: Glaze Drying', 'custom stage');

console.log('staffPieceTitle() — stored staff log titles');
assertEqual(staffPieceTitle('created'), 'Piece Status Shifted', 'created');
assertEqual(staffPieceTitle('kiln'), 'Piece Status Shifted', 'kiln');
assertEqual(staffPieceTitle('ready'), 'Piece Ready for Pickup Alert', 'ready');
assertEqual(staffPieceTitle('collected'), 'Piece Status Shifted', 'collected');
assertEqual(staffPieceTitle('broken'), 'Piece Marked Broken', 'broken');
assertEqual(staffPieceTitle(null), 'Piece Status Shifted', 'custom stage');

// Rows built exactly as notifyPieceStatusChange builds them must still render
// in Arabic: the renderers return Arabic only when the stored English rebuilds.
console.log('Arabic round-trip of rows built from these builders');
for (const key of Object.keys(NAMES) as StageSystemKey[]) {
  const variants = key === 'kiln' ? (['kiln', 'color'] as const) : ([undefined] as const);
  for (const variant of variants) {
    const text = pieceTextForKey(key, 'AC-1806', variant)!;
    const bell = localizeNotification({
      title: customerPieceTitle(key, 'AC-1806', NAMES[key]), message: text.en, newStatus: NAMES[key], pieceName: 'Bowl'
    }, 'ar');
    assertEqual(bell.message, text.ar, `bell ${key}${variant ? ` (${variant})` : ''}: Arabic rendered`);
  }
  const staffMsg = `Piece PC-1234 (Noura) moved to "${NAMES[key]}" by Staff.`;
  const staff = localizeStaffNotification({
    title: staffPieceTitle(key), message: staffMsg, pieceId: 'PC-1234', newStatus: NAMES[key], performedBy: 'Staff'
  }, 'ar');
  assertEqual(staff.message !== staffMsg, true, `staff log ${key}: Arabic rendered`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
