/**
 * Plain-assertion tests for infoPages.ts. No test framework — same style as
 * captcha.test.ts:
 *
 *   npx tsx src/utils/infoPages.test.ts
 */

import {
  INFO_PAGES,
  isInfoPage,
  readInfoPageParam,
  infoPageHref,
  takeInfoPageFromUrl
} from './infoPages';

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

// --- isInfoPage ---------------------------------------------------------------
for (const page of INFO_PAGES) check(`isInfoPage(${page})`, isInfoPage(page));
check('isInfoPage rejects other tabs', !isInfoPage('my-bookings'));
check('isInfoPage rejects empty', !isInfoPage(''));
check('isInfoPage rejects non-strings', !isInfoPage(null) && !isInfoPage(3));

// --- readInfoPageParam --------------------------------------------------------
check('reads ?page=terms', readInfoPageParam('?page=terms') === 'terms');
check('reads without leading ?', readInfoPageParam('page=contact') === 'contact');
check('reads ?page=privacy', readInfoPageParam('?page=privacy') === 'privacy');
check('privacy is a public info page', isInfoPage('privacy'));
check('reads alongside other params',
  readInfoPageParam('?utm_source=ig&page=cancellation-policy') === 'cancellation-policy');
check('ignores unknown page', readInfoPageParam('?page=settings') === null);
check('ignores the staff console', readInfoPageParam('?page=dashboard') === null);
check('ignores case variants', readInfoPageParam('?page=Terms') === null);
check('no param', readInfoPageParam('') === null);
check('payment return is not an info page', readInfoPageParam('?payment=return&id=x') === null);

// --- infoPageHref -------------------------------------------------------------
check('href default path', infoPageHref('terms') === '/?page=terms');
check('href keeps base path', infoPageHref('contact', '/arty/') === '/arty/?page=contact');
check('href round-trips',
  INFO_PAGES.every(p => readInfoPageParam(infoPageHref(p).split('?')[1]) === p));

// --- takeInfoPageFromUrl ------------------------------------------------------
check('takeInfoPageFromUrl without a window is null', takeInfoPageFromUrl() === null);

{
  // A minimal window: enough for the read and the replaceState that clears it.
  let replaced = '';
  const fake = {
    location: { href: 'https://arty.example/?page=terms&x=1', search: '?page=terms&x=1' },
    history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => { replaced = url; } }
  };
  (globalThis as unknown as { window: unknown }).window = fake;
  check('takeInfoPageFromUrl reads the page', takeInfoPageFromUrl() === 'terms');
  check('takeInfoPageFromUrl clears only its own param', replaced === 'https://arty.example/?x=1', replaced);

  replaced = '';
  fake.location = { href: 'https://arty.example/?page=nope', search: '?page=nope' };
  check('unknown page is not taken', takeInfoPageFromUrl() === null);
  check('unknown page leaves the URL alone', replaced === '');
  delete (globalThis as unknown as { window?: unknown }).window;
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
