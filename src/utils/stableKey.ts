/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * JSON with object keys sorted, so two values that differ only in key order
 * compare equal. Postgres jsonb does not keep the key order the app wrote, so
 * a setting read back from the database would otherwise look "changed" next
 * to the object that was saved.
 */
export function stableKey(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'undefined';
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}
