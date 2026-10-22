/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pottery piece photographs: compressing, uploading, and showing them.
 *
 * Piece photos used to be stored as base64 data URLs in pieces.image. Thirty of
 * them reached 47MB, and the console's `pieces?select=*` read started running
 * past the 8s statement timeout — the board then showed nothing at all. Photos
 * now live in the PRIVATE customer-uploads bucket (migration 0021), and the
 * column holds a reference:
 *
 *   storage:customer-uploads/pieces/<piece_id>.<ext>     (migrated rows)
 *   storage:customer-uploads/pieces/new/<uuid>.jpg       (new uploads)
 *
 * The bucket is private because these are customers' own pieces: only staff
 * may read it (storage policy customer_uploads_staff_read). So a reference is
 * not an address — it is resolved to a short-lived signed URL when rendered.
 *
 * Rendering accepts all three kinds of value a row can hold: a storage
 * reference, a legacy data: URL (rows not yet migrated), and a plain http(s)
 * link. Anything that cannot be shown renders the caller's placeholder, never
 * a broken image.
 */

import React, { useEffect, useState } from 'react';
import { getDataClient } from './supabase';
import { MAX_IMAGE_BYTES } from './mediaUpload';

export const PIECE_PHOTO_BUCKET = 'customer-uploads';
const REFERENCE_PREFIX = 'storage:';

/** Longest side of a stored photo, and its JPEG quality. */
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.8;

/** Signed URLs last an hour; a cached one is retired five minutes early. */
const SIGNED_URL_TTL_SECONDS = 60 * 60;
const SIGNED_URL_MARGIN_MS = 5 * 60 * 1000;

// ---- Compression ------------------------------------------------------------

export type PiecePhotoErrorCode = 'undecodable' | 'too-large' | 'unavailable' | 'upload-failed';

/** Carries a code so the console can phrase the message in either language. */
export class PiecePhotoError extends Error {
  constructor(public code: PiecePhotoErrorCode, message: string) {
    super(message);
    this.name = 'PiecePhotoError';
  }
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

/**
 * Decodes a picked file with its EXIF orientation applied.
 *
 * createImageBitmap with imageOrientation 'from-image' is the direct route. A
 * browser that rejects the option (older Safari) falls through to an <img>,
 * which applies EXIF orientation by default. A file neither can read — HEIC on
 * desktop Chrome, say — is an error, not a reason to store the original.
 */
async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // Fall through to the <img> route.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('empty image');
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new PiecePhotoError(
      'undecodable',
      `${file.name || 'This photo'} could not be read by this browser (HEIC photos often cannot be read on a computer). Use the phone camera, or upload a JPEG or PNG.`
    );
  }
}

/**
 * Shrinks a photo to at most 1600px on its longest side and re-encodes it as
 * JPEG at 0.8. Never enlarges. Transparent areas are flattened onto white,
 * since JPEG has no alpha and would otherwise turn them black.
 */
export async function compressPiecePhoto(file: File): Promise<Blob> {
  const decoded = await decodeImage(file);
  try {
    const scale = Math.min(1, MAX_DIMENSION / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new PiecePhotoError('undecodable', 'This browser could not process the photo.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(decoded.source, 0, 0, width, height);

    const blob = await new Promise<Blob | null>(done => canvas.toBlob(done, 'image/jpeg', JPEG_QUALITY));
    if (!blob) throw new PiecePhotoError('undecodable', 'This browser could not process the photo.');
    if (blob.size > MAX_IMAGE_BYTES) {
      throw new PiecePhotoError('too-large', `The photo is still ${(blob.size / 1024 / 1024).toFixed(1)}MB after compression — the limit is 5MB.`);
    }
    return blob;
  } finally {
    decoded.release();
  }
}

// ---- Upload -----------------------------------------------------------------

/**
 * Uploads a compressed photo and returns the reference to store in
 * pieces.image.
 *
 * The piece's id is minted inside addPiece, after this runs, so a new photo is
 * named by a fresh UUID under pieces/new/ rather than by its piece. If the
 * piece is then never saved, the object is left orphaned — there is no
 * cleanup for that yet.
 */
export async function uploadPiecePhoto(photo: Blob): Promise<string> {
  const supabase = getDataClient();
  if (!supabase) {
    throw new PiecePhotoError('unavailable', 'Photo uploads are unavailable — the storage connection is not configured.');
  }

  const path = `pieces/new/${crypto.randomUUID()}.jpg`;
  const { error } = await supabase.storage.from(PIECE_PHOTO_BUCKET).upload(path, photo, {
    contentType: 'image/jpeg',
    upsert: false
  });
  if (error) {
    console.error(`uploadPiecePhoto: ${path} failed:`, error.message);
    throw new PiecePhotoError('upload-failed', error.message || 'The photo could not be uploaded.');
  }
  return `${REFERENCE_PREFIX}${PIECE_PHOTO_BUCKET}/${path}`;
}

// ---- Resolving a stored value to something an <img> can show ------------------

/** Bucket and path of a storage reference, or null for any other value. */
export function parsePieceImageReference(value: string | null | undefined): { bucket: string; path: string } | null {
  if (!value || !value.startsWith(REFERENCE_PREFIX)) return null;
  const rest = value.slice(REFERENCE_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 1 || slash === rest.length - 1) return null;
  return { bucket: rest.slice(0, slash), path: rest.slice(slash + 1) };
}

/** Values an <img> can take as they are: legacy base64, and http(s) links. */
function isDirectSource(value: string): boolean {
  return value.startsWith('data:') || /^https?:\/\//i.test(value);
}

const signedCache = new Map<string, { url: string; expiresAt: number }>();
let queued = new Map<string, Array<(url: string | null) => void>>();
let flushScheduled = false;

/**
 * Signs everything queued in this tick, one createSignedUrls call per bucket.
 *
 * A board or table renders each photo separately; collecting their requests
 * for one tick turns thirty round trips into one.
 */
async function flushSignRequests() {
  flushScheduled = false;
  const batch = queued;
  queued = new Map();

  const byBucket = new Map<string, string[]>();
  for (const reference of batch.keys()) {
    const parsed = parsePieceImageReference(reference)!;
    const paths = byBucket.get(parsed.bucket) || [];
    paths.push(parsed.path);
    byBucket.set(parsed.bucket, paths);
  }

  const settle = (reference: string, url: string | null) => {
    for (const resolve of batch.get(reference) || []) resolve(url);
  };

  const supabase = getDataClient();
  await Promise.all([...byBucket].map(async ([bucket, paths]) => {
    const references = paths.map(path => `${REFERENCE_PREFIX}${bucket}/${path}`);
    if (!supabase) {
      references.forEach(r => settle(r, null));
      return;
    }
    const { data, error } = await supabase.storage.from(bucket).createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);
    if (error || !data) {
      console.error(`Could not sign ${paths.length} piece photo(s):`, error?.message);
      references.forEach(r => settle(r, null));
      return;
    }
    const expiresAt = Date.now() + SIGNED_URL_TTL_SECONDS * 1000 - SIGNED_URL_MARGIN_MS;
    const byPath = new Map(data.map(entry => [entry.path, entry]));
    paths.forEach((path, i) => {
      const entry = byPath.get(path);
      const url = entry && !entry.error && entry.signedUrl ? entry.signedUrl : null;
      if (url) signedCache.set(references[i], { url, expiresAt });
      settle(references[i], url);
    });
  }));
}

/** A signed URL for a storage reference, or null when it cannot be signed. */
function signReference(reference: string): Promise<string | null> {
  const cached = signedCache.get(reference);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.url);

  return new Promise(resolve => {
    const waiters = queued.get(reference) || [];
    waiters.push(resolve);
    queued.set(reference, waiters);
    if (!flushScheduled) {
      flushScheduled = true;
      setTimeout(flushSignRequests, 0);
    }
  });
}

export interface PieceImageProps {
  /** pieces.image as stored: a storage reference, a data: URL, or a link. */
  value: string | null | undefined;
  alt: string;
  className?: string;
  /** Shown while a signed URL is pending, and whenever there is nothing to show. */
  fallback: React.ReactNode;
}

/**
 * A piece photo, or the placeholder — never a broken image.
 *
 * A storage reference that fails to load is re-signed once (the URL may have
 * expired while the page stayed open) before giving up to the placeholder.
 */
export function PieceImage({ value, alt, className, fallback }: PieceImageProps): React.ReactElement {
  const direct = value && !parsePieceImageReference(value) && isDirectSource(value) ? value : null;
  const [signed, setSigned] = useState<{ for: string; url: string | null } | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [resigned, setResigned] = useState(false);

  useEffect(() => {
    setFailedSrc(null);
    setResigned(false);
    if (!value || !parsePieceImageReference(value)) return;
    let cancelled = false;
    signReference(value).then(url => {
      if (!cancelled) setSigned({ for: value, url });
    });
    return () => { cancelled = true; };
  }, [value]);

  const src = direct ?? (signed && signed.for === value ? signed.url : null);
  if (!src || src === failedSrc) return React.createElement(React.Fragment, null, fallback);

  return React.createElement('img', {
    src,
    alt,
    className,
    referrerPolicy: 'no-referrer',
    onError: () => {
      if (value && !direct && !resigned) {
        setResigned(true);
        signedCache.delete(value);
        signReference(value).then(url => {
          if (url && url !== src) setSigned({ for: value, url });
          else setFailedSrc(src);
        });
        return;
      }
      setFailedSrc(src);
    }
  });
}
