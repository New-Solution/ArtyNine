import type { StageSystemKey } from '../types';
import { enumLabel } from './enumLabels';

/**
 * Titles of the two notification rows a piece status change writes (customer
 * bell and staff log), by the stage's system key.
 *
 * The stored English must stay byte-identical: notificationText.ts and
 * staffNotificationText.ts render the Arabic only when a stored row rebuilds
 * exactly from these same wordings. Pinned in pieceSmsTemplates.test.ts.
 */

/** `stageName` is the stage's stored name; a non-special stage shows its display label ("Kiln Time"). */
export function customerPieceTitle(key: StageSystemKey | null | undefined, code: string, stageName: string): string {
  if (key === 'ready') return 'Piece Ready for Pickup!';
  if (key === 'broken') return `Piece ${code} marked as broken`;
  return `Piece Status Update: ${enumLabel('pieceStatus', stageName, 'en')}`;
}

export function staffPieceTitle(key: StageSystemKey | null | undefined): string {
  if (key === 'ready') return 'Piece Ready for Pickup Alert';
  if (key === 'broken') return 'Piece Marked Broken';
  return 'Piece Status Shifted';
}
