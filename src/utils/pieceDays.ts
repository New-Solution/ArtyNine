import type { PipelineStage, PotteryPiece } from '../types';
import { isEndState } from './pipelineStages';

/** Days after which a piece counts as overdue — the Dashboard and the Pottery Pieces page share it. */
export const OVERDUE_PIECE_DAYS = 14;

/**
 * Whether a piece in this stage can be flagged overdue on the Pottery Pieces page:
 * the making stages (custom stages included) and Ready for Pickup, never the
 * end-states Collected or Broken. A piece whose stage can't be found still counts.
 * (The Dashboard list is narrower still — Ready for Pickup only, server-side.)
 */
export const canBeOverdue = (stage: PipelineStage | undefined): boolean => !isEndState(stage);

type DatedPiece = Partial<Pick<PotteryPiece, 'expectedReadyDate' | 'actualReadyDate' | 'readyDate' | 'dateCreated' | 'daysElapsed'>>;

/**
 * Whole days a piece has been waiting, as of `todayDateStr` (Riyadh YYYY-MM-DD).
 *
 * Counted from the expected ready date, falling back to the actual/ready date and
 * then the creation date. Never negative, so a piece whose expected ready date is
 * still ahead reads 0. The stored days_elapsed column is never updated (it stays
 * 0), so it only ever counts if something has set it higher.
 */
export function pieceDaysWaiting(p: DatedPiece, todayDateStr: string): number {
  const fromDate = p.expectedReadyDate || p.actualReadyDate || p.readyDate || p.dateCreated || todayDateStr;
  let days = p.daysElapsed || 0;
  const t1 = new Date(todayDateStr).getTime();
  const t2 = new Date(fromDate.split('T')[0]).getTime();
  if (!isNaN(t1) && !isNaN(t2)) {
    days = Math.max(days, Math.max(0, Math.floor((t1 - t2) / (1000 * 60 * 60 * 24))));
  }
  return days;
}
