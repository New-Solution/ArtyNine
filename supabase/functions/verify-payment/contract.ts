/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Request/response shapes for verify-payment. Same arrangement as
 * send-sms/contract.ts and auto-cancel-bookings/contract.ts.
 */

import type { VerifyState } from '../_shared/moyasarLogic.ts';
import type { PaidBookingSummary } from '../_shared/confirmPayment.ts';

export interface VerifyPaymentRequest {
  /** The Moyasar payment id: from the form's on_completed callback, or the
   *  `id` query parameter Moyasar appends to the callback_url. Nothing else is
   *  accepted — amount, status and booking are read from Moyasar. */
  paymentId: string;
}

export interface VerifyPaymentResponse {
  success: boolean;
  /** Present when success is true. See VerifyState in _shared/moyasarLogic.ts. */
  state?: VerifyState;
  bookingId?: string | null;
  /** Moyasar's decline message, for state 'failed' (English, from the bank). */
  message?: string | null;
  /** For state 'confirmed'. */
  booking?: PaidBookingSummary;
  /** Present when success is false. Safe to show; never contains secrets. */
  error?: string;
}
