/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The public information pages: Cancellation & Refund Policy, Terms &
 * Conditions, Privacy Policy and Contact. Open to everyone, signed in or not.
 *
 * The site has no router, so these are customer tabs like any other. They can
 * also be opened by URL — `?page=cancellation-policy` — because:
 *   - the checkout payment step links to the policy in a NEW tab. Navigating
 *     away in place would unmount the payment form and drop the hold it is
 *     paying for;
 *   - a payment provider or a customer may need a plain link to the policy.
 *
 * No browser APIs at import time, so this runs under plain tsx in
 * infoPages.test.ts.
 */

export const INFO_PAGES = ['cancellation-policy', 'terms', 'privacy', 'contact'] as const;
export type InfoPage = typeof INFO_PAGES[number];

export const INFO_PAGE_PARAM = 'page';

export function isInfoPage(value: unknown): value is InfoPage {
  return typeof value === 'string' && (INFO_PAGES as readonly string[]).includes(value);
}

/** The info page a query string asks for, or null. Unknown values are ignored. */
export function readInfoPageParam(search: string): InfoPage | null {
  const value = new URLSearchParams(search).get(INFO_PAGE_PARAM);
  return isInfoPage(value) ? value : null;
}

/** A same-site link that opens `page` directly: `<pathname>?page=<page>`. */
export function infoPageHref(page: InfoPage, pathname: string = '/'): string {
  return `${pathname}?${INFO_PAGE_PARAM}=${page}`;
}

/**
 * Reads `?page=` once at startup and removes it from the address bar, so a
 * later refresh on another page does not jump back to the info page.
 */
export function takeInfoPageFromUrl(): InfoPage | null {
  if (typeof window === 'undefined') return null;
  const page = readInfoPageParam(window.location.search);
  if (!page) return null;
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete(INFO_PAGE_PARAM);
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    /* the page still opens; the parameter just stays in the address bar */
  }
  return page;
}
