/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Moves pottery piece photographs out of the database and into Storage.
 *
 * Every piece photo was stored as a base64 data URL in pieces.image. Thirty
 * rows reached 47MB, and the console's `pieces?select=*` read now runs past
 * the authenticated role's 8s statement timeout — the read fails, the live
 * table falls back to an empty list, and the Pottery Pieces board shows
 * nothing although every row is still there.
 *
 * This uploads each photo to the PRIVATE customer-uploads bucket (migration
 * 0021) at pieces/<piece_id>.<ext> and replaces the column value with a
 * storage reference, `storage:customer-uploads/pieces/<piece_id>.<ext>`. The
 * console resolves that to a short-lived signed URL at render time
 * (src/lib/pieceImages.ts). Customers have no read access to that bucket.
 *
 * THREE MODES
 *   --backup              Writes every piece's id + image to a local JSONL file
 *                         OUTSIDE the repo, then re-reads it from disk and
 *                         verifies it. Writes nothing to the database.
 *   (default)             Dry run. Prints what would happen per row. Writes
 *                         nothing anywhere.
 *   --apply               Performs the migration. Requires --backup-file.
 *
 * SAFETY
 *   - Never selects `image` for more than one row at a time. The id list is
 *     read on its own; each photo is then fetched by id.
 *   - Only rows whose image starts with 'data:' are touched. Anything already a
 *     storage reference, an http(s) link or empty is skipped, so a second run
 *     has nothing to do.
 *   - --apply refuses a row unless the backup file holds that row's current
 *     image byte-for-byte (sha256), so nothing is converted without a copy.
 *   - Per row: upload, download it back and compare sha256, then update that
 *     one row — guarded so it only applies if the row still holds base64.
 *     A crash mid-run leaves valid base64 behind for the next run.
 *   - Upload uses a stable path with upsert, so retrying a row whose upload
 *     succeeded but whose update failed simply re-uploads the same bytes.
 *   - Formats outside the bucket's allowlist (jpeg/png/webp/gif) or over its
 *     5MB cap are skipped and reported, never converted.
 *
 * Reads the key from the shell environment ONLY — no env file is read, and
 * nothing is written into the repo:
 *
 *   $env:SUPABASE_URL = "https://<ref>.supabase.co"
 *   $env:SUPABASE_SERVICE_ROLE_KEY = "<service_role key>"
 *   node scripts/migrate-piece-photos.mjs --backup --expect-rows 30
 *   node scripts/migrate-piece-photos.mjs --backup-file <path>            # dry run
 *   node scripts/migrate-piece-photos.mjs --backup-file <path> --apply    # real run
 *
 * The service_role key bypasses Row Level Security. Use it only here, only from
 * your own machine, and never put it in .env or any frontend file.
 */

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the shell environment.');
  process.exit(1);
}

const args = process.argv.slice(2);
const flagValue = name => {
  const at = args.indexOf(name);
  return at !== -1 && args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : null;
};

const BACKUP = args.includes('--backup');
const APPLY = args.includes('--apply');
const BACKUP_FILE = flagValue('--backup-file');
const BACKUP_DIR = flagValue('--backup-dir') || join(homedir(), 'arty-backups');
const EXPECT_ROWS = flagValue('--expect-rows') ? Number(flagValue('--expect-rows')) : null;

const BUCKET = 'customer-uploads';
const FOLDER = 'pieces';
/** Mirrors the bucket's own settings (storage.buckets, verified live). */
const ALLOWED_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif']
]);
const MAX_BYTES = 5 * 1024 * 1024;

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

const isDataUrl = v => typeof v === 'string' && v.startsWith('data:');
const sha256 = data => createHash('sha256').update(data).digest('hex');

const bytes = n =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB`
  : n >= 1024 ? `${(n / 1024).toFixed(1)} KB`
  : `${n} B`;

/** A backup inside the repo could end up committed. Refuse it outright. */
function assertOutsideRepo(path) {
  const full = resolve(path);
  if (full === REPO_ROOT || full.startsWith(REPO_ROOT + sep)) {
    console.error(`Refusing to use ${full}: it is inside the repo. Choose a path outside ${REPO_ROOT}.`);
    process.exit(1);
  }
  return full;
}

/** Decodes a data URL into a Buffer plus its content type. Null if unreadable. */
function decodeDataUrl(dataUrl) {
  const match = /^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const contentType = (match[1] || '').trim().toLowerCase();
  const payload = match[4];
  const buffer = match[3]
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');
  return { buffer, contentType };
}

/** Every piece id. Selects `id` alone — never the image column in bulk. */
async function listPieceIds() {
  const ids = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('pieces')
      .select('id')
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`could not list piece ids: ${error.message}`);
    ids.push(...(data || []).map(r => r.id));
    if (!data || data.length < pageSize) break;
  }
  return ids;
}

/** One row's id + image. */
async function fetchImage(id) {
  const { data, error } = await supabase
    .from('pieces')
    .select('id, image')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`could not read piece ${id}: ${error.message}`);
  return data;
}

// ---- --backup ---------------------------------------------------------------

async function runBackup() {
  mkdirSync(assertOutsideRepo(BACKUP_DIR), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = assertOutsideRepo(join(BACKUP_DIR, `pieces-images-${stamp}.jsonl`));
  writeFileSync(file, '');

  console.log('=== BACKUP — reads only, writes nothing to the database ===\n');
  const ids = await listPieceIds();
  console.log(`Pieces in table: ${ids.length}`);

  const written = new Map();
  let totalChars = 0;
  for (const id of ids) {
    const row = await fetchImage(id);
    if (!row) throw new Error(`piece ${id} disappeared during the backup — re-run it`);
    const image = row.image ?? '';
    const record = { id, length: image.length, sha256: sha256(image), image };
    appendFileSync(file, JSON.stringify(record) + '\n');
    written.set(id, record);
    totalChars += image.length;
    process.stdout.write(`  backed up ${id}  ${bytes(image.length).padStart(9)}\n`);
  }

  // Verify against the file as it now sits on disk, not the in-memory copy.
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const problems = [];
  let diskChars = 0;
  const seen = new Set();
  for (const line of lines) {
    const rec = JSON.parse(line);
    seen.add(rec.id);
    diskChars += rec.image.length;
    if (rec.image.length !== rec.length) problems.push(`${rec.id}: length mismatch`);
    if (sha256(rec.image) !== rec.sha256) problems.push(`${rec.id}: checksum mismatch`);
    if (written.get(rec.id)?.sha256 !== rec.sha256) problems.push(`${rec.id}: differs from what was read`);
  }
  for (const id of ids) if (!seen.has(id)) problems.push(`${id}: missing from file`);
  if (lines.length !== ids.length) problems.push(`file has ${lines.length} rows, table has ${ids.length}`);
  if (EXPECT_ROWS !== null && ids.length !== EXPECT_ROWS) {
    problems.push(`expected ${EXPECT_ROWS} rows, table has ${ids.length}`);
  }

  const dataRows = lines.map(l => JSON.parse(l)).filter(r => isDataUrl(r.image)).length;
  console.log('\n=== BACKUP CHECK ===');
  console.log(`File:              ${file}`);
  console.log(`Rows in file:      ${lines.length} (table: ${ids.length}${EXPECT_ROWS !== null ? `, expected: ${EXPECT_ROWS}` : ''})`);
  console.log(`Rows with base64:  ${dataRows}`);
  console.log(`Total image size:  ${bytes(diskChars)} on disk (read: ${bytes(totalChars)})`);
  if (problems.length > 0) {
    console.log('\nBACKUP NOT VERIFIED:');
    for (const p of problems) console.log(`  ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nBackup verified. Use it with:');
  console.log(`  node scripts/migrate-piece-photos.mjs --backup-file "${file}"`);
}

// ---- dry run / --apply --------------------------------------------------------

function loadBackup(path) {
  const full = assertOutsideRepo(path);
  if (!existsSync(full)) {
    console.error(`Backup file not found: ${full}`);
    process.exit(1);
  }
  const map = new Map();
  for (const line of readFileSync(full, 'utf8').split('\n').filter(Boolean)) {
    const rec = JSON.parse(line);
    map.set(rec.id, rec.sha256);
  }
  return map;
}

/** Uploads, downloads back and compares. Returns the storage reference. */
async function uploadAndVerify(path, decoded) {
  const { error } = await supabase.storage.from(BUCKET).upload(path, decoded.buffer, {
    contentType: decoded.contentType,
    upsert: true
  });
  if (error) throw new Error(`upload failed: ${error.message}`);

  const { data: blob, error: dlError } = await supabase.storage.from(BUCKET).download(path);
  if (dlError || !blob) throw new Error(`uploaded but could not read it back: ${dlError?.message || 'empty'}`);
  const stored = Buffer.from(await blob.arrayBuffer());
  if (stored.byteLength !== decoded.buffer.byteLength || sha256(stored) !== sha256(decoded.buffer)) {
    throw new Error(`stored object does not match the original (${stored.byteLength} vs ${decoded.buffer.byteLength} bytes)`);
  }
  return `storage:${BUCKET}/${path}`;
}

async function runMigration() {
  if (APPLY && !BACKUP_FILE) {
    console.error('--apply requires --backup-file <path>. Run --backup first.');
    process.exit(1);
  }
  const backup = BACKUP_FILE ? loadBackup(BACKUP_FILE) : null;

  console.log(APPLY ? '=== MIGRATING (writing) ===\n' : '=== DRY RUN — nothing will be written ===\n');
  if (!backup) console.log('No --backup-file given: backup coverage is not checked in this dry run.\n');

  const ids = await listPieceIds();
  const converted = [];
  const skipped = [];
  const failed = [];

  for (const id of ids) {
    try {
      const row = await fetchImage(id);
      if (!row) { skipped.push({ id, reason: 'row no longer exists' }); continue; }
      const image = row.image ?? '';

      if (!isDataUrl(image)) {
        const reason = !image ? 'no photo'
          : image.startsWith('storage:') ? 'already migrated'
          : /^https?:\/\//i.test(image) ? 'already a link'
          : 'not a data URL';
        skipped.push({ id, reason, quiet: true });
        continue;
      }

      const decoded = decodeDataUrl(image);
      if (!decoded) { skipped.push({ id, reason: 'unreadable data URL' }); continue; }

      const extension = ALLOWED_TYPES.get(decoded.contentType);
      if (!extension) {
        skipped.push({ id, reason: `format ${decoded.contentType || '(none)'} not allowed by the bucket` });
        continue;
      }
      if (decoded.buffer.byteLength > MAX_BYTES) {
        skipped.push({ id, reason: `${bytes(decoded.buffer.byteLength)} is over the bucket's 5 MB cap` });
        continue;
      }
      if (!/^[A-Za-z0-9._-]+$/.test(id)) {
        skipped.push({ id, reason: 'id has characters unsafe for a storage path' });
        continue;
      }

      const backedUp = backup ? backup.get(id) === sha256(image) : null;
      if (APPLY && !backedUp) {
        skipped.push({ id, reason: backup.has(id) ? 'image changed since the backup — take a new backup' : 'not in the backup file' });
        continue;
      }

      const path = `${FOLDER}/${id}.${extension}`;
      const label = `${id}  ${decoded.contentType.padEnd(10)} ${bytes(decoded.buffer.byteLength).padStart(9)}  -> ${BUCKET}/${path}`;

      if (!APPLY) {
        const note = backedUp === null ? '' : backedUp ? '  [in backup]' : '  [NOT IN BACKUP — apply would skip]';
        console.log(`  would convert  ${label}${note}`);
        converted.push({ id });
        continue;
      }

      const reference = await uploadAndVerify(path, decoded);

      // Guarded single-row update: only applies if the row still holds base64,
      // so a change made in the console meanwhile is never overwritten.
      const { data: updated, error: updateError } = await supabase
        .from('pieces')
        .update({ image: reference })
        .eq('id', id)
        .like('image', 'data:%')
        .select('id');
      if (updateError) throw new Error(`row update failed: ${updateError.message} (object ${path} left in place; re-run retries)`);
      if (!updated || updated.length !== 1) {
        throw new Error(`row changed during the run, not updated (object ${path} is now orphaned)`);
      }

      console.log(`  converted      ${label}`);
      converted.push({ id });
    } catch (err) {
      failed.push({ id, error: err.message });
      console.error(`  FAILED         ${id}: ${err.message}`);
    }
  }

  const loud = skipped.filter(s => !s.quiet);
  const quiet = skipped.filter(s => s.quiet);
  console.log('\n=== SUMMARY ===');
  console.log(`Pieces examined: ${ids.length}`);
  console.log(`${APPLY ? 'Converted' : 'Would convert'}:   ${converted.length}`);
  console.log(`Skipped:         ${skipped.length}`);
  const byReason = quiet.reduce((m, s) => m.set(s.reason, (m.get(s.reason) || 0) + 1), new Map());
  for (const [reason, n] of byReason) console.log(`  ${n} x ${reason}`);
  for (const s of loud) console.log(`  ${s.id}: ${s.reason}`);
  console.log(`Failed:          ${failed.length}`);
  for (const f of failed) console.log(`  ${f.id}: ${f.error}`);
  if (failed.length > 0) {
    console.log('\nFailed rows still hold their base64 unless noted above — re-run to retry.');
    process.exitCode = 1;
  }
  if (!APPLY) console.log('\nDry run complete. Nothing was written. Add --apply to perform it.');
}

(BACKUP ? runBackup() : runMigration()).catch(err => {
  console.error('Aborted:', err.message);
  process.exit(1);
});
