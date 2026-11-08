/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Attributes for every input that holds a sign-in credential — an email, a
 * phone-or-email identifier, or a password.
 *
 * iPadOS/iOS capitalise the first letter of a text field and may "correct"
 * words. An email is case-insensitive (canonicalEmail() lowercases and trims
 * it before every sign-in, reset and lookup), but a PASSWORD is not: with
 * "show password" on, the field is type="text" and "secret1" silently becomes
 * "Secret1", which is then rejected as a wrong password. These attributes stop
 * the keyboard changing what was typed. Never use them on a name field —
 * names should be capitalised.
 */
export const CREDENTIAL_INPUT_PROPS = {
  autoCapitalize: 'none',
  autoCorrect: 'off',
  spellCheck: false
} as const;
