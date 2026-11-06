/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Request/response shapes for auto-cancel-bookings. Same arrangement as
 * send-sms/contract.ts and provision-staff/contract.ts.
 */

import type { CancelReason } from './logic.ts';

/** The scheduler sends no body. `dryRun` exists for a manual smoke test. */
export interface AutoCancelRequest {
  /** Decide and report, but write nothing and send nothing. */
  dryRun?: boolean;
}

export interface AutoCancelledBooking {
  bookingId: string;
  reason: CancelReason;
  smsSent: boolean;
  notificationWritten: boolean;
}

/** A payment checked with Moyasar before its hold was expired (0046). */
export interface ReconciledPayment {
  bookingId: string;
  paymentId: string;
  /** VerifyState from _shared/moyasarLogic.ts, or 'error:<reason>'. */
  state: string;
}

export interface AutoCancelResponse {
  success: boolean;
  /** Bookings examined this run. */
  scanned?: number;
  /** Bookings actually cancelled by this run. */
  cancelled?: AutoCancelledBooking[];
  /** Payments checked with Moyasar before expiring holds. */
  reconciled?: ReconciledPayment[];
  /** Set when the run itself failed, not when an individual booking did. */
  error?: string;
}
