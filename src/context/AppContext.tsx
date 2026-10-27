/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { 
  Workshop, Booking, QueueItem, PotteryPiece, TestResult, NotificationItem,
  PipelineStage, StaffMember, WorkshopOption, EventOption, AppSetting, AppEvent, Category,
  WorkshopSessionRecord, StaffScheduleDayEntry, BirthdayPackage, BirthdayFormField,
  DEFAULT_BIRTHDAY_PACKAGES, DEFAULT_BIRTHDAY_FORM_FIELDS, normalizeBirthdayPackage,
  StudioResource, DEFAULT_STUDIO_RESOURCES, CustomerAccount, StaffRole,
  DEFAULT_PIPELINE_STAGES, isStageEnabled, stageCustomerLabel, migrateLegacyPieceStatus,
  DEFAULT_WORKSHOP_OPTIONS, isWorkshopOptionEnabled,
  WorkshopFieldConfig, DEFAULT_WORKSHOP_FIELDS,
  DraftBooking, DEFAULT_LOGGING_FIELDS, LoggingConsoleField
} from '../types';
import { useLiveTable, fetchTable, fetchRow } from '../lib/supabaseData';
import { getDataClient, isStaffSessionActive, onDataClientChange } from '../lib/supabase';
import { notifySeatsChanged } from '../lib/sessionSeats';
import { formatQueueNumber } from '../utils/queueUtils';
import { generateBookingRefCode } from '../utils/idGeneration';

/**
 * How long a booking write may take before the client gives up on it.
 *
 * A normal call resolves in well under a second. Supabase applies its own
 * statement timeout (8s by default) to anything running too long, so a request
 * still alive at 20s is not waiting on the database — it is a connection that
 * has stalled or died without telling us, and no amount of further waiting
 * resolves it.
 *
 * Generous rather than tight, deliberately: cutting off a slow-but-working
 * request on a poor mobile connection would produce exactly the confusion this
 * exists to prevent. Twenty seconds is comfortably above both the server's own
 * limit and any plausible round trip, while being short enough that a customer
 * staring at "Processing Payment..." gets an answer rather than a dead page.
 *
 * Abandoning the request does not abandon the booking: it may still commit
 * server-side, which is why every attempt reuses one reference code and both
 * RPCs treat a repeat of an existing id as success (migration 0028).
 */
const BOOKING_WRITE_TIMEOUT_MS = 20_000;
import { toRow, rowsToModels } from '../lib/mappers';
// Stage 2: the data layer is Supabase. `db` is the Dexie-shaped façade over it
// (lib/supabaseDb), so each mutator keeps its exact logic and invariants while
// the storage underneath changed. Seat allocation does NOT go through it — see
// addBooking, which uses the atomic book_session_seats RPC.
import { sdb as db } from '../lib/supabaseDb';
import { normalizeDateString, timeToMinutes } from '../utils/timeUtils';
import { hasWebsiteAccount, buildAccountLink } from '../utils/accountUtils';
import {
  supabase, supabaseStaff, isSupabaseConfigured, SUPABASE_NOT_CONFIGURED, setStaffSessionActive
} from '../lib/supabase';
import { FunctionsHttpError } from '@supabase/supabase-js';
import {
  normalizeCustomerPhone, toDisplayPhone, findCustomerMatch, buildCustomerIdentity,
  mergeCustomerDetails, findDuplicateGroups, customerPhoneKey
} from '../utils/customerIdentity';
import {
  validateRequired, validatePhoneRule, validateEmailRule, validatePasswordRule,
  canonicalPhone, canonicalEmail, phoneMatchKey, customerStorageFields, staffStorageFields
} from '../utils/validation';
import {
  canAccessPage, hasConsoleAccount, sanitizePermissions,
  SettingsSectionId, resolveSettingsSection
} from '../utils/adminAccess';
import { 
  getRiyadhNow, 
  parseBookingDateTimeToRiyadhDate, 
  getRiyadhDateString, 
  getRiyadhFormattedDate, 
  getRelativeRiyadhDateStr 
} from '../utils/dateUtils';
import { validateSaudiPhone, normaliseSaudiPhone, normalisePhone } from '../utils/phoneUtils';
import { formatDate, RIYADH_TIME_ZONE } from '../utils/calendarConfig';
import { pieceStatusText, bilingualSms, PICKUP_REMINDER_TEXT, type KilnSmsVariant } from '../utils/pieceSmsTemplates';
import { enumLabel } from '../utils/enumLabels';
import { bookingCancellationSms } from '../../supabase/functions/_shared/bookingSmsTemplates';
import { PHONE_AUTH_ENABLED } from '../utils/featureFlags';
import { toE164Saudi, isPhoneSetupPending } from '../utils/phoneAuth';
import { getConfiguredTables, computeTableStates, validateTableSelection } from '../utils/tableSeatingUtils';

export {
  getRiyadhNow,
  parseBookingDateTimeToRiyadhDate,
  getRiyadhDateString,
  getRiyadhFormattedDate,
  getRelativeRiyadhDateStr
};

/**
 * Mirrors supabase/functions/provision-staff/contract.ts (audit finding
 * C-3). Not imported directly — the Edge Function runs on Deno, the app on
 * Vite/Node, different toolchains — so this is kept in sync by hand. Change
 * both files together.
 */
export interface ProvisionStaffSuccess {
  success: true;
  staffId: string;
  status: 'invited' | 'already-provisioned';
}

export interface ProvisionStaffCollision {
  success: false;
  staffId: string;
  code: 'identity_collision';
  message: string;
  hasExistingCustomerRecord: boolean;
}

export interface ProvisionStaffError {
  success: false;
  staffId?: string;
  code:
    | 'unauthenticated'
    | 'forbidden'
    | 'not_found'
    | 'invalid_input'
    | 'inactive_staff'
    | 'duplicate_email'
    | 'linked_identity_mismatch'
    | 'linked_identity_missing'
    | 'identity_belongs_to_other_staff'
    | 'internal_error';
  message: string;
}

export type ProvisionStaffResponse =
  | ProvisionStaffSuccess
  | ProvisionStaffCollision
  | ProvisionStaffError;

/**
 * What provisionStaff() actually returns: either the function ran and gave
 * a structured answer (success, idempotent, collision, or a specific
 * rejection reason), or the request never reached it at all. Callers must
 * not conflate the two — see provisionStaff()'s own comment.
 */
export type ProvisionStaffOutcome =
  | { kind: 'response'; response: ProvisionStaffResponse }
  | { kind: 'network_error'; message: string };

/**
 * What sendPickupReminder() actually returns (SMS integration, Chunk 2).
 * 'sent' always means send_piece_pickup_reminder's database write already
 * committed — an SMS failure past that point can never roll it back, it
 * only means smsSent is false. 'cooldown' means nothing was written and
 * no SMS was attempted; 'failed' means the RPC itself didn't succeed
 * (network error, or the piece no longer qualifies at all).
 */
export type SendPickupReminderOutcome =
  | { outcome: 'sent'; smsSent: true }
  | { outcome: 'sent'; smsSent: false; smsError: string }
  | { outcome: 'cooldown' }
  | { outcome: 'failed'; error: string };

interface AppContextType {
  // Navigation
  /**
   * Which area of the app is showing. The customer site is the default and is
   * open to everyone; the staff console is a separate area reached only by an
   * explicit staff sign-in. There is no free toggle between the two.
   */
  area: 'customer' | 'staff';
  /** Opens the staff sign-in screen. Grants nothing on its own. */
  goToStaffLogin: () => void;
  /** Leaves the staff area for the customer site, keeping the session. */
  viewCustomerSite: () => void;
  /** Returns a signed-in staff member to the console. */
  returnToStaffConsole: () => void;
  customerTab: 'home' | 'workshops' | 'detail' | 'checkout-info' | 'checkout-payment' | 'confirmation' | 'my-bookings' | 'my-pieces' | 'auth' | 'birthday-booking' | 'reset-password';
  setCustomerTab: (tab: 'home' | 'workshops' | 'detail' | 'checkout-info' | 'checkout-payment' | 'confirmation' | 'my-bookings' | 'my-pieces' | 'auth' | 'birthday-booking' | 'reset-password') => void;
  adminTab: 'dashboard' | 'queue' | 'customers' | 'staff' | 'bookings' | 'workshops-admin' | 'events-admin' | 'pieces-admin' | 'system-health' | 'settings';
  setAdminTab: (tab: 'dashboard' | 'queue' | 'customers' | 'staff' | 'bookings' | 'workshops-admin' | 'events-admin' | 'pieces-admin' | 'system-health' | 'settings') => void;
  
  // Pending Checkout State
  pendingBooking: DraftBooking | null;
  setPendingBooking: (booking: DraftBooking | null) => void;
  
  // Birthday Package State
  selectedBirthdayPackage: string;
  setSelectedBirthdayPackage: (pkg: string) => void;
  /** Category chip the Workshops page should open on, e.g. set to 'Birthday Packages'
   *  before navigating there from the home page. Callers that navigate to the
   *  Workshops page for a general browse should reset this to 'All' first. */
  workshopsInitialCategory: string;
  setWorkshopsInitialCategory: (category: string) => void;

  // Auth state
  currentUser: { id?: string; name: string; email: string; phone: string } | null;
  setCurrentUser: (user: { id?: string; name: string; email: string; phone: string } | null) => void;
  authScreen: 'login' | 'register' | 'forgot';
  setAuthScreen: (screen: 'login' | 'register' | 'forgot') => void;
  registerCustomer: (data: { name: string; email: string; phone: string; password?: string }) => Promise<{ success: boolean; error?: string }>;
  /**
   * Signs a customer in with EITHER their phone number or their email address.
   * `needsPasswordSetup` means the identifier matched an unclaimed record and
   * the claim flow should be offered instead of a password error.
   */
  loginCustomer: (emailOrPhone: string, password?: string) =>
    Promise<{
      success: boolean;
      error?: string;
      needsPasswordSetup?: boolean;
      /** The masked address the claim confirmation will be sent to, if known. */
      claimEmailHint?: string;
      /** True when the record has no email, so the claim needs phone OTP. */
      awaitingPhoneVerification?: boolean;
    }>;
  /**
   * Attaches a password to an existing passwordless record and signs them in.
   * `email` is required when the identifier is a phone number: the auth account
   * is created against an address, and the record's own address is never
   * disclosed to the browser.
   */
  claimCustomerAccount: (emailOrPhone: string, password: string, email?: string) =>
    Promise<{
      success: boolean;
      error?: string;
      customerId?: string;
      needsEmailConfirmation?: boolean;
    }>;
  /** Sends a reset link. The reply never reveals whether the email exists. */
  requestPasswordReset: (email: string) =>
    Promise<{ success: boolean; error?: string; message?: string }>;
  /** True once the emailed link's recovery session has been established. */
  hasRecoverySession: () => Promise<boolean>;
  /** Supabase's own explanation when it rejected a reset link. */
  recoveryLinkError: string | null;
  /** Sets the new password using the recovery session from the emailed link. */
  completePasswordReset: (newPassword: string) =>
    Promise<{ success: boolean; error?: string; expired?: boolean }>;
  resetCustomerPassword: (emailOrPhone: string, newPassword: string) => Promise<{ success: boolean; error?: string }>;
  /**
   * Changes the signed-in customer's own password. Requires their live session
   * — there is no identifier argument, so it can only ever act on the caller.
   */
  changeCustomerPassword: (newPassword: string) =>
    Promise<{ success: boolean; error?: string; needsSignIn?: boolean }>;
  logoutCustomer: () => void;

  // Active items for detail/editing
  selectedWorkshopId: string;
  setSelectedWorkshopId: (id: string) => void;
  lastBookingCreated: Booking | null;
  setLastBookingCreated: (b: Booking | null) => void;
  editingWorkshopId: string | null;
  /** Which Settings subsection is open. Driven by the sidebar submenu. */
  settingsSection: SettingsSectionId;
  setSettingsSection: (section: SettingsSectionId) => void;

  /** Booking the Events & Socials page should open, set by the Dashboard. */
  selectedEventBookingId: string | null;
  setSelectedEventBookingId: (id: string | null) => void;
  setEditingWorkshopId: (id: string | null) => void;

  // Global Data States
  todayDateStr: string;
  formattedTodayDate: string;
  getRelativeRiyadhDateStr: (daysOffset: number, baseDate?: Date) => string;
  getRiyadhFormattedDate: (date?: Date) => string;
  workshops: Workshop[];
  bookings: Booking[];
  queue: QueueItem[];
  pieces: PotteryPiece[];
  systemTests: TestResult[];
  notifications: NotificationItem[];
  events: AppEvent[];
  /** Canonical workshop session table — the single source of truth for staff assignments. */
  workshopSessions: WorkshopSessionRecord[];
  /** Stored customer accounts. The account-type filter reads these. */
  customers: CustomerAccount[];

  // ---- Admin Console session ----
  /** The signed-in staff member, or null. Never defaults to a staff record. */
  currentStaff: StaffMember | null;
  staffAuthChecked: boolean;
  loginStaff: (emailOrPhone: string, password: string) =>
    Promise<{ success: boolean; error?: string; mustChangePassword?: boolean }>;
  /** Replaces the signed-in staff member's password (Supabase Auth). */
  changeStaffPassword: (newPassword: string) => Promise<{ success: boolean; error?: string }>;
  logoutStaff: () => void;
  /** Page-level authorization for the signed-in staff member. */
  canAccessAdminPage: (pageId: string) => boolean;

  /**
   * Finds the shared customer for these details, or creates one. The primary
   * match is the normalized phone, so a returning customer is never duplicated.
   */
  resolveCustomer: (
    input: {
      name?: string;
      phone?: string;
      email?: string;
    },
    /**
     * How this customer first reached the studio. Written only when the record
     * is created — see the implementation. Omitted, the database falls back to
     * 'Website', which is what every caller used to get whether it was true or
     * not.
     */
    source?: CustomerAccount['source']
  ) => Promise<{ customer: CustomerAccount; created: boolean; matchedOn: string }>;

  /** Studio rooms and table stations — one shared record used everywhere. */
  studioResources: StudioResource[];
  addStudioResource: (resource: Omit<StudioResource, 'id'>) => Promise<void>;
  updateStudioResource: (id: string, updates: Partial<StudioResource>) => Promise<void>;
  /** Resources tied to history are deactivated, never hard-deleted. */
  removeStudioResource: (id: string) => Promise<{ success: boolean; message?: string; deactivated?: boolean }>;

  /** Shared birthday packages — edited in the Staff Console, rendered on the customer site. */
  birthdayPackages: BirthdayPackage[];
  publishedBirthdayPackages: BirthdayPackage[];
  addBirthdayPackage: (pkg: Omit<BirthdayPackage, 'id'>) => Promise<void>;
  updateBirthdayPackage: (id: string, updates: Partial<BirthdayPackage>) => Promise<void>;
  deleteBirthdayPackage: (id: string) => Promise<void>;
  reorderBirthdayPackages: (ordered: BirthdayPackage[]) => Promise<void>;
  /** Field structure of the two Workshop cards, configured in Settings. */
  workshopFields: WorkshopFieldConfig[];
  updateWorkshopFields: (fields: WorkshopFieldConfig[]) => Promise<void>;

  /** Customer birthday booking-form fields, configured in Settings → Events/Birthday. */
  birthdayFormFields: BirthdayFormField[];
  updateBirthdayFormFields: (fields: BirthdayFormField[]) => Promise<void>;

  // Settings & Lists
  pipelineStages: PipelineStage[];
  staff: StaffMember[];
  workshopOptions: WorkshopOption[];
  eventOptions: EventOption[];
  categories: Category[];
  /** Raw workshop/event queries: `undefined` until the first read resolves. */
  rawWorkshops: Workshop[] | undefined;
  rawEvents: AppEvent[] | undefined;
  appSettings: AppSetting[];
  loggingFields: LoggingConsoleField[];
  updateLoggingFields: (fields: LoggingConsoleField[]) => Promise<void>;
  
  // Mutators
  addWorkshop: (ws: Omit<Workshop, 'id' | 'slug'>) => void;
  updateWorkshop: (id: string, updates: Partial<Workshop>) => void;
  /** A customer's session ended without them asking. See the implementation. */
  sessionExpired: boolean;
  clearSessionExpired: () => void;
  /** A signed-in phone account that has not finished setup (VITE_PHONE_AUTH only; always false otherwise). */
  phoneSetupPending: boolean;

  addBooking: (
    booking: Omit<Booking, 'id' | 'createdAt' | 'timeline'>,
    existingRefCode?: string
  ) => Promise<Booking>;
  /** Set when the last booking write failed, so the UI never claims success. */
  bookingError: string | null;
  clearBookingError: () => void;
  cancelBooking: (id: string, user?: string, paymentStatusUpdate?: 'Refunded' | 'Paid' | 'Unpaid') => void;
  /**
   * A customer cancelling their own booking. Separate from cancelBooking()
   * because a customer session cannot write `bookings` — see cancel_own_booking
   * in migration 0017. Resolves with the reason when it was refused, so the
   * page can say why instead of appearing to succeed.
   */
  cancelOwnBooking: (id: string) => Promise<{ success: boolean; error?: string; refunded?: boolean }>;
  updateBookingStatus: (id: string, status: Booking['status'], paymentStatus?: Booking['paymentStatus'], user?: string) => void;
  /** A fresh read of the records an assignment conflict check needs. */
  getFreshAssignmentSources: () => Promise<{
    staff: StaffMember[];
    workshopSessions: WorkshopSessionRecord[];
    workshops: Workshop[];
    events: AppEvent[];
    queue: QueueItem[];
    studioResources: StudioResource[];
    appSettings: AppSetting[];
  }>;
  /** Staff read straight from the database, bypassing the cached list. */
  getFreshStaff: () => Promise<StaffMember[]>;
  /** A customer's piece count, regardless of the caller's pieces-admin permission. */
  getCustomerPieceCount: (customerId?: string, phone?: string) => Promise<number>;
  /** Assigns or clears the staff member hosting a birthday/event booking. */
  assignBookingStaff: (bookingId: string, staffId: string | null) =>
    Promise<{ success: boolean; error?: string }>;
  /** Adds a category unless one with that name already exists. */
  addCategoryIfMissing: (name: string) => Promise<{ created: boolean; id?: string }>;
  /** Sets or clears (null) a category's optional Arabic display name. Writes name_ar only. */
  updateCategoryNameAr: (id: string, nameAr: string | null) => Promise<void>;
  /** Updates a single workshop session record. */
  updateWorkshopSession: (id: string, updates: Partial<WorkshopSessionRecord>) => Promise<void>;
  /** Appends one entry to a booking's timeline. */
  appendBookingTimeline: (bookingId: string, action: string) => Promise<void>;
  /** Raises a staff notification through the shared notifications table. */
  addStaffNotification: (
    title: string,
    message: string,
    meta?: { newStatus?: string; performedBy?: string; highlighted?: boolean }
  ) => Promise<void>;
  addQueueItem: (item: Omit<QueueItem, 'id' | 'checkInTime' | 'elapsedMinutes' | 'status' | 'date' | 'history'>) => Promise<{ success: boolean; error?: string }>;
  updateQueueStatus: (id: string, status: QueueItem['status']) => void;
  updateQueueItem: (id: string, updates: Partial<QueueItem>) => Promise<void>;
  /**
   * Assigns (or clears) café tables on a Waiting/Called entry without moving
   * it — the tables become reserved capacity. Pass an empty array to leave it
   * unassigned again.
   */
  assignQueueTables: (id: string, tableIds: string[]) => Promise<{ success: boolean; error?: string }>;
  /** Moves a Without Instructor entry to In Progress. Table(s) are required. */
  seatQueueItem: (id: string, tableIds: string[]) => Promise<{ success: boolean; error?: string }>;
  /** Moves an In Progress entry's seating to a different set of table(s). */
  changeQueueItemTables: (id: string, tableIds: string[]) => Promise<{ success: boolean; error?: string }>;
  returnQueueItemToWaiting: (
    id: string,
    opts: { hours: number; participants: number; tableIds: string[] }
  ) => Promise<{ success: boolean; message?: string; newId?: string }>;
  reorderQueue: (newQueue: QueueItem[]) => void;
  updatePieceStatus: (id: string, status: PotteryPiece['status'], performerUser?: string, reason?: string, smsVariant?: KilnSmsVariant) => void;
  addPiece: (piece: Omit<PotteryPiece, 'id' | 'daysElapsed' | 'expectedCompletion' | 'notes'> & Partial<Pick<PotteryPiece, 'expectedCompletion' | 'notes'>>) => void;
  updatePiece: (id: string, updates: Partial<PotteryPiece>) => Promise<void>;
  /** Dashboard "Pottery Awaiting Pickup" widget data (audit finding C-4) — fed by get_overdue_pickup_pieces(), works for any console-access staff member regardless of the pieces-admin permission. */
  overduePickupPieces: PotteryPiece[];
  markPieceCollected: (piece: {
    id: string; name: string; pieceCode?: string; customerName: string; customerPhone: string;
  }) => Promise<{ success: boolean; error?: string }>;
  sendPickupReminder: (piece: {
    id: string; name: string; pieceCode?: string; customerName: string; customerPhone: string;
  }) => Promise<SendPickupReminderOutcome>;
  markNotificationAsRead: (id: string) => Promise<void>;
  clearAllNotifications: (type?: 'customer' | 'staff') => Promise<void>;
  runAllTests: () => void;
  toggleTestResult: (id: string) => void;
  isTestRunning: boolean;
  testProgress: number;
  testsPassing: boolean;

  // Events Mutators
  addEvent: (evt: Omit<AppEvent, 'id' | 'spotsLeft'>) => Promise<void>;
  updateEvent: (id: string, updates: Partial<AppEvent>) => Promise<void>;
  deleteEvent: (id: string) => Promise<{ success: boolean; message?: string }>;

  // Settings Mutators
  addPipelineStage: (stage: Omit<PipelineStage, 'id' | 'order'>) => Promise<void>;
  updatePipelineStage: (id: string, updates: Partial<PipelineStage>) => Promise<void>;
  deletePipelineStage: (id: string) => Promise<{ success: boolean; message?: string; deactivated?: boolean }>;
  reorderPipelineStages: (newStages: PipelineStage[]) => Promise<void>;

  /** Creates a guest customer record. Never linked to a website account. */
  addCustomer: (
    customer: Omit<CustomerAccount, 'id' | 'createdAt'>
  ) => Promise<{ success: boolean; error?: string; customerId?: string }>;
  updateCustomer: (id: string, updates: Partial<CustomerAccount>) =>
    Promise<{ success: boolean; error?: string }>;
  addStaffMember: (member: Omit<StaffMember, 'id'>) => Promise<void>;
  updateStaffMember: (id: string, updates: Partial<StaffMember>) => Promise<void>;
  deleteStaffMember: (id: string) => Promise<{ success: boolean; message?: string; assignmentsCount?: number }>;
  /** Establishes staff.user_id through the provision-staff Edge Function (audit finding C-3). Super Admin only — the function re-verifies that server-side regardless of who calls it. */
  provisionStaff: (staffId: string) => Promise<ProvisionStaffOutcome>;

  addWorkshopOption: (option: Omit<WorkshopOption, 'id' | 'order'>) => Promise<void>;
  updateWorkshopOption: (id: string, value: string) => Promise<void>;
  deleteWorkshopOption: (id: string) => Promise<{ success: boolean; message?: string }>;
  reorderWorkshopOptions: (type: WorkshopOption['type'], newOptions: WorkshopOption[]) => Promise<void>;

  addEventOption: (option: Omit<EventOption, 'id' | 'order'>) => Promise<void>;
  updateEventOption: (id: string, value: string) => Promise<void>;
  deleteEventOption: (id: string) => Promise<{ success: boolean; message?: string }>;
  reorderEventOptions: (type: EventOption['type'], newOptions: EventOption[]) => Promise<void>;

  updateSetting: (id: string, value: any) => Promise<void>;
  removeAllData: () => Promise<void>;
  reseedSampleData: () => Promise<void>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);


// The previous hardcoded bootstrap credentials were removed in Stage 1b: they
// were committed to a public repository and are permanently compromised.
// Supabase Auth owns credentials; see README, "First Super Admin".

interface BookingSessionLink {
  sessionId?: string;
  staffId?: string;
  staffName: string;
  startTime?: string;
  endTime?: string;
  duration?: string;
  capacity?: number;
}

/**
 * Resolves a booking's real workshop session and its assigned staff member:
 * booking.sessionId → workshop session → staffId → current staff record.
 * Returns an unassigned link rather than guessing when nothing matches — there is
 * deliberately no default instructor.
 */
const resolveBookingSessionLink = async (booking: Booking): Promise<BookingSessionLink> => {
  const unassigned: BookingSessionLink = { staffName: 'Unassigned' };
  try {
    let session = booking.sessionId ? await db.workshopSessions.get(String(booking.sessionId)) : undefined;

    if (!session && booking.workshopId && booking.date) {
      // Legacy bookings saved before sessionId existed.
      const candidates = await db.workshopSessions.where('workshopId').equals(booking.workshopId).toArray();
      const bookingDate = normalizeDateString(booking.date);
      const bookingStart = booking.time ? timeToMinutes(booking.time.split(' - ')[0].trim()) : null;
      session = candidates.find(s =>
        normalizeDateString(s.date) === bookingDate &&
        (bookingStart === null || timeToMinutes(s.startTime) === bookingStart)
      );
    }

    if (!session) return unassigned;

    const member = session.staffId ? await db.staff.get(session.staffId) : undefined;

    return {
      sessionId: String(session.id),
      staffId: member?.id,
      staffName: member?.name || 'Unassigned',
      startTime: session.startTime,
      endTime: session.endTime,
      duration: session.duration,
      capacity: session.capacity
    };
  } catch (err) {
    console.error('Failed to resolve booking session link:', err);
    return unassigned;
  }
};


// ================= AUTH HELPERS (Stage 1b) =================

/** Turns a Supabase Auth error into something a customer can act on. */
function friendlyAuthError(message: string): string {
  const m = String(message || '').toLowerCase();
  if (m.includes('already registered') || m.includes('already been registered')) {
    return 'An account with this email address already exists. Please sign in instead.';
  }
  if (m.includes('invalid login credentials')) {
    return 'Incorrect email or password. Please try again.';
  }
  if (m.includes('email not confirmed')) {
    return 'Please confirm your email address first — check your inbox for the link.';
  }
  return message || 'Sign-in failed. Please try again.';
}

/**
 * Attaches an auth user to the ONE shared customer record for that identifier.
 *
 * ⚠️ OWNERSHIP VERIFICATION
 * This links an account to a record found by phone or email. It must only run
 * once Supabase Auth has proven the caller controls that identifier. Today that
 * proof is the email confirmation link. A phone-only claim MUST NOT attach on
 * knowledge of the number alone.
 * TODO(stage-2): when phone sign-in is enabled, gate this behind
 * supabase.auth.verifyOtp() for the phone channel before calling the RPC.
 *
 * Stage 2: the RPC is the only writer. There is no local customer write.
 */
async function linkAuthToCustomer(identifier: string | undefined, authId: string): Promise<string | null> {
  const input = String(identifier || '').trim();
  if (!input || !authId || !supabase) return null;

  // The RPC is the real path: a customer session cannot read a row whose
  // user_id is null, so the lookup has to happen with elevated rights. It
  // matches on the same normalized phone/email rule as the app, is idempotent,
  // and returns null identically for "no record" and "claimed by someone else"
  // so it cannot be used to discover which numbers are on file.
  const { data, error } = await supabase.rpc('link_existing_customer', {
    identifier: input,
    new_auth_id: authId
  });

  if (error) {
    console.error('link_existing_customer failed:', error.message);
    return null;
  }
  return (typeof data === 'string' && data) ? data : null;
}

/**
 * Post-split, the staff console and customer site are served from
 * different origins. That's a real subdomain once there's a custom
 * domain (staff.artycafe.com), but today it's Vercel's auto-generated
 * preview/production URL (arty-staff.vercel.app), where "staff" is a
 * hyphen-separated word rather than a dot-separated label. Splitting on
 * both '.' and '-' and requiring an exact 'staff' segment matches both,
 * while still rejecting an unrelated domain that merely contains "staff"
 * as a substring of a longer word (e.g. staffing-tool.vercel.app).
 * Anything else — including localhost/dev — defaults to 'customer';
 * the existing "Staff Login" click is still how you reach the staff area
 * locally, unchanged by this.
 */
function initialAreaFromHostname(): 'customer' | 'staff' {
  if (typeof window === 'undefined') return 'customer';
  const segments = window.location.hostname.split(/[.-]/);
  if (segments.includes('staff')) return 'staff';
  // Local dev shortcut (no separate staff hostname to test against):
  // visiting with ?staff lands straight in the staff console. Dev-only.
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('staff')) return 'staff';
  return 'customer';
}

/**
 * Cross-domain link targets, set only once the two sites are actually
 * deployed separately. Unset (local dev, or a single shared deployment)
 * falls back to today's in-app setArea(...) switch — see goToStaffLogin,
 * viewCustomerSite and returnToStaffConsole below.
 */
const CUSTOMER_SITE_URL = import.meta.env.VITE_CUSTOMER_SITE_URL || undefined;
const STAFF_SITE_URL = import.meta.env.VITE_STAFF_SITE_URL || undefined;

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Navigation State
  // Everyone starts on the customer site, unless the hostname says otherwise (see initialAreaFromHostname).
  const [area, setArea] = useState<'customer' | 'staff'>(initialAreaFromHostname);

  // Keeps the tab title honest about which site you're on — matters most
  // in local dev / a single shared deployment, where the same tab can
  // switch between areas via setArea without a real navigation.
  useEffect(() => {
    document.title = area === 'staff' ? 'Arty Café — Staff Console' : 'Arty Café';
  }, [area]);

  /** What Supabase said about a reset link, when it refused one. */
  const [recoveryLinkError, setRecoveryLinkError] = useState<string | null>(null);

  /**
   * A password-reset link opens the recovery screen.
   *
   * Supabase puts `type=recovery` in the URL fragment and raises
   * PASSWORD_RECOVERY once it has exchanged it for a short-lived session.
   * Either signal routes there.
   */
  useEffect(() => {
    const hash = window.location.hash || '';
    const search = window.location.search || '';

    // Supabase reports a dead link as an error in the fragment. Capture it so
    // the screen can say what went wrong rather than guessing.
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const linkError = params.get('error_description') || params.get('error');
    if (linkError) setRecoveryLinkError(linkError.replace(/\+/g, ' '));

    // Only a RECOVERY link opens the reset screen.
    //
    // This used to fire on a bare `access_token` in the fragment, which every
    // Supabase auth link carries — signup confirmation and email-change
    // included. So confirming a new email address dumped the customer on "Set a
    // new password", and if they already had one it dead-ended on "New password
    // should be different from the old password". The type is what distinguishes
    // them, so the type is what is checked.
    const linkType = params.get('type') || new URLSearchParams(search.replace(/^\?/, '')).get('type');
    const isRecovery = linkType === 'recovery' || linkError !== null;

    if (isRecovery) {
      setArea('customer');
      setCustomerTab('reset-password');
    }

    if (!supabase) return;
    const { data } = supabase.auth.onAuthStateChange(event => {
      if (event === 'PASSWORD_RECOVERY') {
        setArea('customer');
        setCustomerTab('reset-password');
      }
    });
    return () => data.subscription.unsubscribe();
  }, []);
  const [customerTab, setCustomerTab] = useState<'home' | 'workshops' | 'detail' | 'checkout-info' | 'checkout-payment' | 'confirmation' | 'my-bookings' | 'my-pieces' | 'auth' | 'birthday-booking' | 'reset-password'>('home');
  const [adminTab, setAdminTab] = useState<'dashboard' | 'queue' | 'customers' | 'staff' | 'bookings' | 'workshops-admin' | 'events-admin' | 'pieces-admin' | 'system-health' | 'settings'>('dashboard');
  
  // Pending Checkout State
  const [pendingBooking, setPendingBooking] = useState<DraftBooking | null>(null);
  /**
   * Set when a booking write fails. The booking used to fail silently in the
   * background while the confirmation screen still said "confirmed" — the
   * customer left believing they had a seat.
   */
  const [bookingError, setBookingError] = useState<string | null>(null);
  
  // Birthday Package Selection State
  // Holds the id of the package the customer picked; resolved from the shared record.
  const [selectedBirthdayPackage, setSelectedBirthdayPackage] = useState<string>('');
  const [workshopsInitialCategory, setWorkshopsInitialCategory] = useState<string>('All');

  // Auth State (Initialized ONLY from localStorage session, defaults strictly to null)
  // Derived from the Supabase session on load, never trusted from storage.
  const [currentUser, setCurrentUser] = useState<{ id?: string; name: string; email: string; phone: string } | null>(null);
  const [authScreen, setAuthScreen] = useState<'login' | 'register' | 'forgot'>('login');

  const registerCustomer = async (data: { name: string; email: string; phone: string; password?: string }) => {
    // The same shared rules the forms use, enforced again here so no caller can
    // write an invalid record by skipping a form.
    const nameCheck = validateRequired(data.name, 'Full name');
    if (!nameCheck.valid) return { success: false, error: nameCheck.error };

    const emailCheck = validateEmailRule(data.email);
    if (!emailCheck.valid) return { success: false, error: emailCheck.error };

    const phoneCheck = validatePhoneRule(data.phone);
    if (!phoneCheck.valid) return { success: false, error: phoneCheck.error };

    const passwordCheck = validatePasswordRule(data.password);
    if (!passwordCheck.valid) return { success: false, error: passwordCheck.error };

    if (!supabase) return { success: false, error: SUPABASE_NOT_CONFIGURED };

    const normEmail = canonicalEmail(data.email);
    const normPhone = canonicalPhone(data.phone);
    const phoneKey = phoneMatchKey(data.phone);

    // Matched on the normalized key, so a record stored in any older format is
    // still recognised as the same person.
    const allCustomers = await db.customers.toArray();
    const existingEmail = allCustomers.find(c => canonicalEmail(c.email) === normEmail);
    const existingPhone = allCustomers.find(c => customerPhoneKey(c) === phoneKey);
    const existing = existingEmail || existingPhone;

    // A record that is already linked to an account must sign in instead.
    if (existing && hasWebsiteAccount(existing)) {
      return {
        success: false,
        error: existingEmail
          ? 'An account with this email address already exists. Please sign in instead.'
          : 'An account with this phone number already exists. Please sign in instead.'
      };
    }

    // Supabase Auth creates and hashes the credential. No password is ever
    // written to a customer record.
    const { data: signUp, error: signUpError } = await supabase.auth.signUp({
      email: normEmail,
      password: data.password!
    });

    if (signUpError) {
      return { success: false, error: friendlyAuthError(signUpError.message) };
    }

    const authId = signUp.user?.id;
    if (!authId) {
      return { success: false, error: 'Could not create the account. Please try again.' };
    }

    // Attach the auth user to the shared customer record.
    // One call does the whole thing in Postgres: reuse the existing record for
    // this phone/email if there is one — so a walk-in keeps their history —
    // otherwise create it, and attach the new auth user either way.
    //
    // This must not be a client-side insert: right after sign-up there may be
    // no session yet (email confirmation), so the caller is still anonymous and
    // RLS would refuse the write. That is exactly what left an auth user with
    // no customer record.
    const { data: resolvedId, error: linkError } = await supabase.rpc('resolve_customer_record', {
      p_name: data.name.trim(),
      p_phone: normPhone,
      p_email: normEmail,
      p_auth_id: authId,
      p_source: 'Website Registration'
    });

    if (linkError || !resolvedId) {
      return {
        success: false,
        error: linkError?.message || 'Account created, but the customer record could not be saved.'
      };
    }

    const custId: string = resolvedId;

    // Email confirmation is on: there is no session until they confirm.
    if (!signUp.session) {
      return {
        success: false,
        needsEmailConfirmation: true,
        error: 'Almost there — check your email and confirm your address to finish creating your account.'
      };
    }

    setCurrentUser({ id: custId, name: data.name.trim(), email: normEmail, phone: normPhone });
    return { success: true };
  };

  /**
   * Asks Postgres which sign-in route an identifier needs.
   *
   * This cannot be answered in the browser: an anonymous visitor cannot read
   * `customers` at all (the RLS policies are `to authenticated` and scoped to
   * their own row), so a local lookup finds nothing before sign-in and every
   * walk-in would be told their password was wrong.
   *
   * The function folds "no record" and "already claimed" into the same
   * `password` answer, so this cannot be used to discover which numbers or
   * addresses are on file.
   */
  const resolveSignInRoute = async (
    identifier: string
  ): Promise<{ route: 'password' | 'claim_email' | 'claim_phone_pending'; emailHint?: string }> => {
    if (!supabase) return { route: 'password' };

    const { data, error } = await supabase.rpc('customer_signin_route', {
      identifier: String(identifier || '').trim()
    });

    if (error) {
      console.error('customer_signin_route failed:', error.message);
      // Fail closed: ask for a password rather than opening the claim flow on
      // an identifier whose status is unknown.
      return { route: 'password' };
    }

    const route = (data as any)?.route;
    if (route === 'claim_email' || route === 'claim_phone_pending') {
      return { route, emailHint: (data as any)?.email_hint || undefined };
    }
    return { route: 'password' };
  };

  /**
   * The single place a successful customer sign-in actually gets
   * written — called by loginCustomer() (both its normal path and the
   * claim_email retry), registerCustomer(), and claimCustomerAccount().
   *
   * The same sign-in that leads here also fires Supabase's SIGNED_IN
   * event, which independently triggers customerSub -> resolveSessions()
   * — a second, concurrent, speculative re-derivation of the same
   * state from its own separate lookup. Unlike that lookup, this call
   * fires synchronously with data already fully resolved and verified
   * (Supabase Auth has already checked the credential) — there's no
   * async gap during which it could go stale. So this write is treated
   * as unconditionally authoritative: it bumps the shared generation
   * counter itself (never subject to its own guard check, the same way
   * logoutCustomer()'s sign-out is never questioned), which means any
   * resolveSessions() call finishing afterward — even one that
   * independently came back with "not found" on its own speculative
   * lookup — will see its own captured generation as stale and
   * correctly skip overwriting this result.
   */
  const signInCustomerRecord = (customer: CustomerAccount) => {
    sessionGenerationRef.current += 1;
    setCurrentUser({
      id: customer.id, name: customer.name, email: customer.email, phone: customer.phone
    });
  };

  /**
   * Customer sign-in with EITHER a phone number or an email address.
   *
   * The identifier is resolved server-side first, because which of three things
   * should happen depends on a row the browser is not allowed to read:
   *
   *   - an unclaimed record (a walk-in, an admin entry, a counter booking)
   *     is routed into the claim flow — never told its password is wrong;
   *   - a real website account is asked for its password, and a wrong one
   *     gets the ordinary error, NOT the claim flow;
   *   - an identifier with nothing behind it is answered exactly like a real
   *     account, so this cannot be used to discover who is on file.
   *
   * Supabase Auth still mints every session. A phone sign-in only needs the
   * address the account lives at, and the RPC releases that solely to a caller
   * who has already proved they hold the password.
   */
  /**
   * After Supabase Auth has already authenticated `authUser` for `email`,
   * resolves (and links, if needed) the customers row that session
   * should attach to. Extracted so loginCustomer()'s claim_email retry
   * below can share the exact same call sequence its ordinary password
   * path already used, rather than keeping a second, driftable copy.
   *
   * No new security surface: linkAuthToCustomer() and
   * resolve_customer_record() are unchanged, called with the same
   * verified email either way — see loginCustomer()'s own doc comment
   * for why that's safe.
   */
  const resolveCustomerForAuthUser = async (
    email: string,
    authUser: { id: string; user_metadata?: Record<string, unknown> | null }
  ): Promise<CustomerAccount | undefined> => {
    const linkedId = await linkAuthToCustomer(email, authUser.id);
    let customer =
      (await db.customers.toArray()).find(c => c.userId === authUser.id) ||
      (linkedId ? await db.customers.get(linkedId) : undefined);

    // An authenticated account with no customer record behind it. This
    // happens when sign-up created the auth user but the record write
    // did not land. Create and attach it now rather than leaving them
    // locked out.
    if (!customer && supabase) {
      const { data: healedId } = await supabase.rpc('resolve_customer_record', {
        p_name: (authUser.user_metadata as { name?: string } | null | undefined)?.name ?? null,
        p_phone: null,
        p_email: email,
        p_auth_id: authUser.id,
        p_source: 'Website Registration'
      });
      if (healedId) customer = await db.customers.get(healedId);
    }

    return customer;
  };

  const loginCustomer = async (emailOrPhone: string, password?: string) => {
    const input = String(emailOrPhone || '').trim();
    if (!input) return { success: false, error: 'Email or phone number is required.' };
    if (!password) return { success: false, error: 'Enter your password.' };
    if (!supabase) return { success: false, error: SUPABASE_NOT_CONFIGURED };

    const typedEmail = canonicalEmail(input);
    const looksLikeEmail = typedEmail.includes('@');

    // Phone accounts (VITE_PHONE_AUTH only): a phone-like identifier is tried
    // as a Supabase phone sign-in first. Any failure falls through to the
    // unchanged path below, which ends in the same "Incorrect phone number or
    // password." — so the two cannot be told apart.
    if (PHONE_AUTH_ENABLED && !looksLikeEmail) {
      const e164 = toE164Saudi(input);
      if (e164) {
        const { data: phoneData, error: phoneError } = await supabase.auth.signInWithPassword({ phone: e164, password });
        if (!phoneError && phoneData.user) {
          let customer = (await db.customers.toArray()).find(c => c.userId === phoneData.user.id);
          if (!customer) {
            // Verified phone, not yet linked: link_customer_by_verified_phone()
            // reads the phone from this session (migration 0041).
            const { data: link, error: linkError } = await supabase.rpc('link_customer_by_verified_phone', { p_name: null });
            if (linkError) console.error('link_customer_by_verified_phone failed:', linkError.message);
            const linkedId = (link as { customer_id?: string } | null)?.customer_id;
            if (linkedId) customer = await db.customers.get(linkedId);
          }
          if (!customer) {
            return { success: false, error: 'No customer record is linked to this account yet.' };
          }
          signInCustomerRecord(customer);
          return { success: true };
        }
      }
    }

    // Step 1 — which route? An unclaimed record is offered the claim flow
    // before any credential is tried, so it never sees a password error.
    // Phone sign-in on: no lookup at all — nothing is said about whether a
    // number or address is on file until a password has been checked. A
    // studio-made record is claimed with "Get a code instead".
    const { route, emailHint } = PHONE_AUTH_ENABLED
      ? { route: 'password' as const, emailHint: undefined }
      : await resolveSignInRoute(input);

    if (route === 'claim_email') {
      // 'claim_email' means the customers ROW is unclaimed
      // (customer_signin_route() only ever looks at public.customers,
      // never auth.users) — it does NOT mean no Auth account exists for
      // this email. Those are independent facts: a real Auth account can
      // already exist here (e.g. a registration that created the Auth
      // user but never completed the resolve_customer_record link — the
      // exact gap registerCustomer()'s own comment on that RPC call
      // already documents), in which case its real password should
      // still work rather than being refused before ever being tried.
      //
      // Scoped to an email-typed identifier only: with an email already
      // in hand, signInWithPassword() can be attempted directly. A
      // phone-typed identifier reaching this route has no equivalent
      // path today — customer_signin_email() requires row.user_id to
      // already be set (it reads auth.users through that id), so it
      // cannot resolve the real email for a still-unclaimed row. That
      // narrower case keeps today's "claim" messaging below, unchanged.
      if (looksLikeEmail) {
        const { data: attemptData, error: attemptError } = await supabase.auth.signInWithPassword({
          email: typedEmail,
          password
        });

        if (!attemptError && attemptData.user) {
          // A real account existed after all. Attach it exactly the way
          // an ordinary sign-in already does below — same
          // linkAuthToCustomer()/resolve_customer_record() calls, same
          // verified email, no new security surface: reaching this line
          // already required knowing the account's real password,
          // checked entirely by Supabase Auth's own credential store,
          // unrelated to anything in the customers table.
          const customer = await resolveCustomerForAuthUser(typedEmail, attemptData.user);
          if (customer) {
            signInCustomerRecord(customer);
            return { success: true };
          }
          // Authenticated, but truly nothing to attach even after the
          // heal attempt — fall through to the claim messaging below.
        }
        // Wrong password, or genuinely no Auth account for this email:
        // fall through to the claim/setup messaging below, unchanged.
      }

      return {
        success: false,
        needsPasswordSetup: true,
        claimEmailHint: emailHint,
        error: looksLikeEmail
          ? 'This email is on file from a visit or booking, but it does not have an account yet. Set a password to claim it.'
          : 'This number is on file from a visit or booking, but it does not have an account yet. Set a password to claim it.'
      };
    }

    if (route === 'claim_phone_pending') {
      // ⚠️ OWNERSHIP VERIFICATION — the record has a phone and no email, so
      // there is nothing to send a confirmation to and knowing the number
      // proves nothing. The claim is offered but cannot complete; see
      // claimCustomerAccount().
      // TODO(stage-2): gate behind supabase.auth.signInWithOtp({ phone }) +
      // verifyOtp() once SMS is enabled, then allow it without an email.
      return {
        success: false,
        // No claim form is offered: it could not complete, and an unusable form
        // is worse than a clear explanation.
        awaitingPhoneVerification: true,
        error: 'This number is on file from a visit or booking, but there is no email address on the record to send a confirmation link to. Please ask the studio to add your email, then set your password here.'
      };
    }

    // Step 2 — a password is expected. Signing in by phone needs the address
    // the auth account lives at; the RPC returns it only once the password
    // checks out, and returns nothing at all for a wrong one or an unknown
    // identifier, so the two are indistinguishable.
    let email = typedEmail;
    if (!looksLikeEmail) {
      const { data: resolvedEmail, error: lookupError } = await supabase.rpc('customer_signin_email', {
        p_identifier: input,
        p_password: password
      });

      if (lookupError) {
        console.error('customer_signin_email failed:', lookupError.message);
        return { success: false, error: 'Could not sign you in right now. Please try again.' };
      }

      if (typeof resolvedEmail !== 'string' || !resolvedEmail.includes('@')) {
        return { success: false, error: 'Incorrect phone number or password.' };
      }
      email = canonicalEmail(resolvedEmail);
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.user) {
      // Route resolution already handled the unclaimed case, so a failure here
      // is a genuinely wrong credential and says so plainly.
      return { success: false, error: friendlyAuthError(error?.message || '') };
    }

    // Resolve the shared record from the auth id, linking it on first sign-in.
    const customer = await resolveCustomerForAuthUser(email, data.user);

    if (!customer) {
      return { success: false, error: 'No customer record is linked to this account yet.' };
    }

    signInCustomerRecord(customer);
    return { success: true };
  };

  /**
   * Claims an existing passwordless record: creates the auth user and attaches
   * it to the record already found by normalized phone or email. No second
   * customer is ever created.
   *
   * ⚠️ OWNERSHIP VERIFICATION — see linkAuthToCustomer(). The claim only
   * completes once Supabase Auth has proven the caller controls the address
   * (the email confirmation link). Knowing a phone number must never be enough.
   */
  const claimCustomerAccount = async (emailOrPhone: string, password: string, email?: string) => {
    const input = String(emailOrPhone || '').trim();
    if (!input) return { success: false, error: 'Email or phone number is required.' };
    if (!supabase) return { success: false, error: SUPABASE_NOT_CONFIGURED };

    const strength = validatePasswordRule(password);
    if (!strength.valid) return { success: false, error: strength.error };

    // The record itself is unreadable from here — an anonymous caller cannot
    // select a row whose user_id is null — so its status comes from the same
    // route function the sign-in used. A claimed identifier is refused without
    // confirming that it is claimed.
    const { route } = await resolveSignInRoute(input);
    if (route === 'password') {
      return {
        success: false,
        error: 'That account cannot be set up here. Please sign in, or use Forgot password.'
      };
    }

    if (route === 'claim_phone_pending') {
      // ⚠️ OWNERSHIP VERIFICATION — the record holds a phone number and no
      // email, so there is nothing to send a confirmation link to. Knowing the
      // number proves nothing, and letting any address claim it would hand the
      // record to whoever typed the number first. The claim stops here.
      // TODO(stage-2): when SMS is enabled, prove the phone channel with
      // supabase.auth.signInWithOtp({ phone }) + verifyOtp() and claim on that
      // verification instead of on an email.
      return {
        success: false,
        error: 'We cannot finish setting this up online yet — there is no email address on your record. Please ask the studio to add one, then claim your account.'
      };
    }

    // The address the auth account is created against, and where the
    // confirmation link goes. Either the identifier itself is an email, or one
    // was typed in the claim form; the record's own address is never disclosed
    // to the browser, only ever masked as a hint.
    const claimEmail = canonicalEmail(email) || canonicalEmail(input);

    if (!claimEmail.includes('@')) {
      return {
        success: false,
        error: 'Enter the email address on your record, and we will send a confirmation link to finish claiming your account.'
      };
    }

    // Claiming by phone: the typed address must be the one the studio already
    // holds. The confirmation link only proves the visitor owns that address —
    // it says nothing about their being this customer — so any other address
    // would let whoever knows the number take the record.
    if (canonicalEmail(input) !== claimEmail) {
      const { data: matches, error: matchError } = await supabase.rpc('customer_claim_email_matches', {
        p_identifier: input,
        p_email: claimEmail
      });

      if (matchError) {
        console.error('customer_claim_email_matches failed:', matchError.message);
        return { success: false, error: 'Could not set up your account right now. Please try again.' };
      }

      if (matches !== true) {
        // Deliberately does not say which address is on file.
        return {
          success: false,
          error: 'That email address does not match the one on your record. Check the hint above, or ask the studio to confirm it.'
        };
      }
    }

    // The claim attaches to the record matched by the ORIGINAL identifier — the
    // phone number, when that is what was typed — so a walk-in's bookings,
    // queue visits and pottery all stay on the one record. The typed email only
    // ever names the auth account.
    const { data, error } = await supabase.auth.signUp({ email: claimEmail, password });
    if (error) return { success: false, error: friendlyAuthError(error.message) };

    const authId = data.user?.id;
    if (!authId) return { success: false, error: 'Could not create the account. Please try again.' };

    // Email confirmation is on: there is no session yet, so auth.uid() is not
    // this caller and claim_customer_account() correctly will not attach
    // anything (see 0010_fix_customer_ownership_verification.sql). Ask for
    // confirmation now rather than attempting the link and reporting the
    // wrong error; resolveSessions()'s heal step completes the claim
    // automatically once the confirmation link is opened and the session
    // becomes real.
    if (!data.session) {
      return {
        success: false,
        needsEmailConfirmation: true,
        error: 'Almost there — check your email and confirm your address to finish claiming your account.'
      };
    }

    // Matched on the identifier that was signed in with, not on the typed
    // email, so no second customer is ever created for the same person.
    const linkedId = await linkAuthToCustomer(input, authId);
    if (!linkedId) {
      return { success: false, error: 'No account found with these details. Please create an account.' };
    }

    const claimed = await db.customers.get(linkedId);
    if (claimed) signInCustomerRecord(claimed);

    return { success: true, customerId: linkedId };
  };

  /**
   * Sends a password-reset link.
   *
   * Supabase Auth owns the proof of ownership: only someone who can open the
   * inbox can complete the reset. That is also why this is the correct path for
   * an unclaimed customer record — no special case is needed or wanted.
   *
   * The response is deliberately identical whether or not the address is on
   * file, so this cannot be used to discover which emails are registered.
   */
  const requestPasswordReset = async (email: string) => {
    const address = canonicalEmail(email);
    const generic = 'If an account exists for that address, a reset link is on its way. Check your inbox and spam folder.';

    if (!address.includes('@')) {
      return { success: false, error: 'Enter a valid email address.' };
    }
    if (!supabase) return { success: false, error: SUPABASE_NOT_CONFIGURED };

    const { error } = await supabase.auth.resetPasswordForEmail(address, {
      // No fragment of our own: Supabase appends its token as the URL
      // fragment, and a URL can only have one. Adding "#reset-password" here
      // produced "#reset-password#access_token=..." — unparseable, so no
      // session was ever created and every link looked expired.
      // The reset screen is reached from `type=recovery` / PASSWORD_RECOVERY.
      redirectTo: `${window.location.origin}${window.location.pathname}`
    });

    if (error) {
      console.error('Password reset request failed:', error.message);

      // Two kinds of failure, and only one of them is safe to describe.
      //
      // A per-account failure ("no such user", "email not confirmed") must stay
      // behind the generic message — saying anything specific turns this form
      // into a way of discovering which addresses have accounts, which is what
      // the generic wording exists to prevent.
      //
      // An infrastructure failure — rate limit, provider outage, SMTP
      // misconfiguration — says nothing about whether the account exists, and
      // reporting success for it is a plain lie: the customer waits for an
      // email that was never sent and has no reason to retry. Those are named.
      const reason = String(error.message || '').toLowerCase();
      const isInfrastructure =
        error.status === 429 ||
        error.status === 500 ||
        error.status === 502 ||
        error.status === 503 ||
        /rate limit|too many requests|smtp|sending|provider|timeout|unavailable/.test(reason);

      if (isInfrastructure) {
        return {
          success: false,
          error: 'We are having trouble sending email right now. Please try again in a few minutes.'
        };
      }
    }

    return { success: true, message: generic };
  };

  /**
   * Whether a recovery session exists yet.
   *
   * Reading the token out of the URL is asynchronous, so the reset screen can
   * render before it lands. This is polled briefly rather than declaring a
   * perfectly good link expired.
   */
  const hasRecoverySession = async (): Promise<boolean> => {
    const clients = [supabase, supabaseStaff].filter(Boolean) as NonNullable<typeof supabase>[];
    for (const client of clients) {
      const { data } = await client.auth.getSession();
      if (data.session) return true;
    }
    return false;
  };

  /**
   * Completes a reset. Requires the recovery session Supabase establishes when
   * the emailed link is opened; without it there is nothing to update.
   */
  const completePasswordReset = async (newPassword: string) => {
    if (!supabase) return { success: false, error: SUPABASE_NOT_CONFIGURED };

    const strength = validatePasswordRule(newPassword);
    if (!strength.valid) return { success: false, error: strength.error };

    // The recovery session belongs to whichever client read the link. The
    // default client is the only one that reads the URL, but a staff member
    // resetting while signed in to the console may hold it there instead, so
    // both are checked before declaring the link dead.
    const clients = [supabase, supabaseStaff].filter(Boolean) as NonNullable<typeof supabase>[];

    let holder: (typeof clients)[number] | null = null;
    for (const client of clients) {
      const { data } = await client.auth.getSession();
      if (data.session) { holder = client; break; }
    }

    if (!holder) {
      return {
        success: false,
        expired: true,
        error: 'This reset link has expired or has already been used. Request a new one.'
      };
    }

    const { error } = await holder.auth.updateUser({ password: newPassword });
    if (error) return { success: false, error: friendlyAuthError(error.message) };

    return { success: true };
  };

  /**
   * Retired. It set a password from an identifier alone, which is exactly the
   * unverified reset the fake "123456" flow relied on: knowing an email or a
   * phone number was enough to take over an account.
   *
   * Resets now go through Supabase Auth — requestPasswordReset emails a link,
   * completePasswordReset uses the recovery session it creates. Kept only so
   * the context contract does not change; it never succeeds.
   */
  const resetCustomerPassword = async (
    _emailOrPhone: string,
    _newPassword: string
  ): Promise<{ success: boolean; error?: string }> => ({
    success: false,
    error: 'Password resets are sent by email. Use "Forgot password?" to get a secure link.'
  });

  /**
   * Changes the password of whoever is signed in on the customer client.
   *
   * Supabase resolves the account from the session cookie, so there is nothing
   * to pass and nothing to spoof: a caller can only change their own. An
   * account that was never claimed has no auth session, and is told to use the
   * emailed link rather than being handed a way to set a password from the
   * page.
   */
  const changeCustomerPassword = async (newPassword: string) => {
    if (!supabase) return { success: false, error: SUPABASE_NOT_CONFIGURED };

    const strength = validatePasswordRule(newPassword);
    if (!strength.valid) return { success: false, error: strength.error };

    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      return {
        success: false,
        needsSignIn: true,
        error: 'Your session has expired, or this account has not been set up with a password yet. Sign in again, or use "Forgot password?" to set one by email.'
      };
    }

    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) return { success: false, error: friendlyAuthError(error.message) };

    return { success: true };
  };

  /**
   * True when a customer's session ended WITHOUT them asking for it — the token
   * expired or was revoked, and Supabase dropped it.
   *
   * Detection is not ours: @supabase/auth-js registers its own
   * `visibilitychange` handler and re-checks the session every time the tab
   * becomes visible, removing it and emitting SIGNED_OUT when the refresh
   * genuinely fails. That already worked. What was missing is that
   * `setCurrentUser(null)` happened in silence, so the customer was simply
   * signed out mid-session with no explanation.
   *
   * THREE GUARDS keep this from firing when it should not, because a customer
   * told "your session expired" right after they clicked Sign Out is a worse
   * bug than the one being fixed:
   *
   *   1. The event must be SIGNED_OUT specifically. INITIAL_SESSION (first
   *      load, no session) and TOKEN_REFRESHED both carry a null-or-changed
   *      session and must not count.
   *   2. There must have been a customer session immediately before. On first
   *      load there was not, so nothing can announce an expiry to someone who
   *      was never signed in.
   *   3. It must not be an app-initiated sign-out. logoutCustomer sets a flag
   *      the listener consumes.
   */
  const [sessionExpired, setSessionExpired] = useState(false);
  /**
   * Phone sign-up signs the visitor in before the password step. Until
   * user_metadata.phone_setup_complete is written, AuthSection shows "Finish
   * setting up your account" instead of anything else; My Bookings and My
   * Pieces send them there. Read from the session the listener already has.
   */
  const [phoneSetupPending, setPhoneSetupPending] = useState(false);
  useEffect(() => {
    if (!PHONE_AUTH_ENABLED || !phoneSetupPending) return;
    if (customerTab === 'my-bookings' || customerTab === 'my-pieces') setCustomerTab('auth');
  }, [phoneSetupPending, customerTab]);
  /** Set for the duration of a deliberate sign-out. Guard 3. */
  const intentionalSignOutRef = useRef(false);
  /** Whether a customer was signed in as of the last event. Guard 2. */
  const hadCustomerSessionRef = useRef(false);

  const logoutCustomer = async () => {
    // Signing out is a SIGNED_OUT event like any other, so the listener has to
    // be told this one was asked for. Without this, clicking Sign Out would
    // announce "your session expired", which is worse than the silence it
    // replaces.
    intentionalSignOutRef.current = true;
    setSessionExpired(false);
    // Supabase owns the session; signing out clears it everywhere.
    if (supabase) await supabase.auth.signOut();
    // Belt and braces: if signOut() threw, or emitted nothing, the flag must
    // not survive to swallow a genuine expiry later.
    intentionalSignOutRef.current = false;
    setCurrentUser(null);
    setCustomerTab('home');
  };

  // Active element triggers
  const [selectedWorkshopId, setSelectedWorkshopId] = useState<string>('ws-1');
  const [lastBookingCreated, setLastBookingCreated] = useState<Booking | null>(null);
  const [editingWorkshopId, setEditingWorkshopId] = useState<string | null>(null);
  const [selectedEventBookingId, setSelectedEventBookingId] = useState<string | null>(null);

  // Settings subsection, restored on refresh so the same section reopens.
  const [settingsSection, setSettingsSectionState] = useState<SettingsSectionId>(
    () => resolveSettingsSection(localStorage.getItem('artycafe_settings_section'))
  );

  const setSettingsSection = (section: SettingsSectionId) => {
    setSettingsSectionState(section);
    localStorage.setItem('artycafe_settings_section', section);
  };
  const isSyncingQueueRef = React.useRef(false);

  // Shared Date State (Riyadh Local Time)
  const [todayDateStr, setTodayDateStr] = useState<string>(() => getRiyadhDateString());
  const [formattedTodayDate, setFormattedTodayDate] = useState<string>(() => getRiyadhFormattedDate());

  // Timer to keep shared date live past midnight
  useEffect(() => {
    const updateTodayDate = () => {
      const currentStr = getRiyadhDateString();
      const currentFormatted = getRiyadhFormattedDate();
      setTodayDateStr(prev => (prev !== currentStr ? currentStr : prev));
      setFormattedTodayDate(prev => (prev !== currentFormatted ? currentFormatted : prev));
    };

    updateTodayDate();
    const interval = setInterval(updateTodayDate, 10000);
    return () => clearInterval(interval);
  }, []);

  // ================= LIVE DATA (Supabase) =================
  // Each list is fetched once and then kept current by a realtime channel.
  //
  // `undefined` means the first read has not resolved yet. That is the loading
  // signal — there are no seed-data fallbacks: a pending or failed read yields
  // an empty list so the UI can never show phantom records.
  const rawWorkshops = useLiveTable<Workshop>('workshops');
  const rawEvents = useLiveTable<AppEvent>('events');
  const rawBookings = useLiveTable<Booking>('bookings');
  const rawQueue = useLiveTable<QueueItem>('queue');
  /**
   * Pottery is read from a different relation depending on who is asking.
   *
   * `pieces` and `piece_history` are staff-only by policy — 0001_init made them
   * so deliberately, and 0014 narrowed the staff policy further to require the
   * pieces-admin permission. Neither ever granted customers access, and neither
   * should: `damage_note` is an internal handling note that customers must not
   * be able to select.
   *
   * The customer-facing relations are the views built for exactly this in
   * 0001_init: `customer_pieces` and `customer_piece_history`. They scope
   * themselves to `current_customer_id()` and simply do not list `damage_note`
   * among their columns, so there is no SQL path by which a customer session can
   * read it. That is stronger than filtering it out in the client, and it is why
   * the fix here is to read the right relation rather than to add a SELECT
   * policy to the base table — a policy would hand customers the whole row and
   * leave every future reader responsible for hiding one column.
   *
   * Reading the base table from a customer session returned nothing at all,
   * which is why My Pieces showed "no pieces registered" for every customer who
   * had them.
   *
   * The switch follows the SESSION, not the page: a customer cannot end up on
   * the staff relation because some screen set a tab.
   */
  const [staffSession, setStaffSession] = useState(isStaffSessionActive());
  useEffect(() => onDataClientChange(() => setStaffSession(isStaffSessionActive())), []);

  const rawPieces = useLiveTable<PotteryPiece>(staffSession ? 'pieces' : 'customer_pieces');
  const rawPieceHistory = useLiveTable<any>(
    staffSession ? 'piece_history' : 'customer_piece_history',
    { orderBy: 'timestamp' }
  );
  const rawCustomers = useLiveTable<CustomerAccount>('customers');
  const rawStaff = useLiveTable<StaffMember>('staff');
  const rawSessions = useLiveTable<WorkshopSessionRecord>('workshop_sessions');
  const rawNotifications = useLiveTable<NotificationItem>('notifications');
  const rawCategories = useLiveTable<Category>('categories');
  const rawAppSettings = useLiveTable<AppSetting>('app_settings');
  const rawStudioResources = useLiveTable<StudioResource>('studio_resources', { orderBy: 'order' });
  const rawBirthdayPackages = useLiveTable<BirthdayPackage>('birthday_packages', { orderBy: 'display_order' });
  const rawPipelineStages = useLiveTable<PipelineStage>('pipeline_stages', { orderBy: 'order' });
  const rawWorkshopOptions = useLiveTable<WorkshopOption>('workshop_options', { orderBy: 'order' });
  const rawEventOptions = useLiveTable<EventOption>('event_options', { orderBy: 'order' });

  const events = rawEvents || [];
  const bookings = rawBookings || [];
  const queue = rawQueue || [];
  const customers = rawCustomers || [];
  const staff = rawStaff || [];
  const notifications = rawNotifications || [];
  const categories = rawCategories || [];
  const appSettings = rawAppSettings || [];
  const studioResources = rawStudioResources || [];
  const pipelineStages = rawPipelineStages || [];
  const workshopOptions = rawWorkshopOptions || [];
  const eventOptions = rawEventOptions || [];
  const workshopSessions = rawSessions || [];

  // Results are produced by running the real suite, not seeded from a list.
  const systemTests: TestResult[] = [];

  // A piece's history lives in its own append-only table; it is stitched back
  // onto the piece so every existing reader of `piece.history` still works.
  const pieces = React.useMemo(() => {
    const byPiece = new Map<string, any[]>();
    for (const entry of rawPieceHistory || []) {
      const list = byPiece.get(entry.pieceId) || [];
      list.push({
        status: entry.status,
        timestamp: entry.timestamp,
        riyadhTime: entry.riyadhTime,
        user: entry.user,
        reason: entry.reason || undefined
      });
      byPiece.set(entry.pieceId, list);
    }
    return (rawPieces || []).map(p => ({ ...p, history: byPiece.get(p.id) || [] }));
  }, [rawPieces, rawPieceHistory]);

  // Sessions are their own table now. They are also attached to their workshop
  // so the places that read `workshop.sessions` keep working unchanged.
  const workshops = React.useMemo(() => {
    const byWorkshop = new Map<string, WorkshopSessionRecord[]>();
    for (const session of rawSessions || []) {
      const list = byWorkshop.get(session.workshopId) || [];
      list.push(session);
      byWorkshop.set(session.workshopId, list);
    }
    return (rawWorkshops || []).map(w => ({ ...w, sessions: byWorkshop.get(w.id) || [] }));
  }, [rawWorkshops, rawSessions]);

  // Older records are filled in so the customer site has one consistent shape.
  const birthdayPackages = React.useMemo(
    () => (rawBirthdayPackages || []).map(normalizeBirthdayPackage),
    [rawBirthdayPackages]
  );

  /**
   * Makes sure every default birthday package exists and is up to date.
   *
   * Creates a package that is missing entirely (the previous version only
   * upgraded packages that already existed, so a database holding just Package 1
   * never gained Package 2), and refreshes records saved before the structured
   * content fields existed. Staff edits are preserved: display order, published
   * state and a custom image are kept, and packages that already carry the
   * structured fields are left untouched.
   */
  // Birthday packages are seeded by 0001_init.sql; there is no client-side
  // self-heal any more.


  // The database is seeded by supabase/migrations/0001_init.sql. There is no
  // client-side seeding: an empty table means an empty table.


  // Migrate any existing "No Show" to "Cancelled" and "Confirmed" to "Pending"
  useEffect(() => {
    const runMigration = async () => {
      try {
        const allBookings = await db.bookings.toArray();
        for (const b of allBookings) {
          let updated = false;
          let updatedStatus = b.status;
          let updatedTimeline = b.timeline ? [...b.timeline] : [];
          
          if ((b.status as string) === 'No Show') {
            updatedStatus = 'Cancelled';
            updatedTimeline.push({
              time: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
              action: 'Migrated status from No Show to Cancelled'
            });
            updated = true;
          } else if ((b.status as string) === 'Confirmed') {
            updatedStatus = 'Pending';
            updatedTimeline.push({
              time: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
              action: 'Migrated status from Confirmed to Pending'
            });
            updated = true;
          }
          
          if (updated) {
            await db.bookings.update(b.id, {
              status: updatedStatus,
              timeline: updatedTimeline
            });
          }
        }
      } catch (err) {
        console.error("Error migrating statuses in DB:", err);
      }
    };
    runMigration();
  }, [bookings.length]);

  // Sanitize queue items: Ensure completed/cancelled items from previous days are assigned their actual completion date
  useEffect(() => {
    const sanitizeQueueDates = async () => {
      try {
        const todayRiyadh = getRiyadhDateString();
        const allQueue = await db.queue.toArray();
        for (const item of allQueue) {
          if (item.status === 'Completed' || item.status === 'Cancelled') {
            const completedHist = item.history?.find(h => h.status === 'Completed' || h.status === 'Cancelled');
            if (completedHist && completedHist.timestamp) {
              const compDate = completedHist.timestamp.split('T')[0];
              if (compDate && compDate < todayRiyadh && item.date === todayRiyadh) {
                await db.queue.update(item.id, { date: compDate });
              }
            }
          }
        }
      } catch (err) {
        console.error("Error sanitizing queue dates:", err);
      }
    };
    sanitizeQueueDates();
  }, [todayDateStr]);

  // Auto-sync today's bookings into the Live Queue when their day comes
  useEffect(() => {
    const syncTodayBookingsToQueue = async () => {
      if (isSyncingQueueRef.current) return;
      isSyncingQueueRef.current = true;
      try {
        const todayRiyadh = getRiyadhDateString();
        const todayBookings = await db.bookings.where('date').equals(todayRiyadh).toArray();

        for (const b of todayBookings) {
          if (b.status === 'Cancelled') continue;

          // Fresh query on each iteration to prevent race conditions within loop
          const currentQueue = await db.queue.toArray();

          // Check if already in queue for today.
          //
          // Terminal rows are excluded: a Cancelled or Completed entry is a
          // finished visit, not someone already queued, and matching it blocked
          // every later booking that person made the same day — silently, since
          // a skip logs nothing. A cancelled booking's queue row is left in
          // place rather than deleted, so this was reachable simply by
          // cancelling and rebooking.
          //
          // The phone and name arms stay: they are what stops a walk-in who
          // also holds a booking being queued twice under two rows.
          const exists = currentQueue.some(q =>
            q.date === todayRiyadh &&
            q.status !== 'Cancelled' &&
            q.status !== 'Completed' &&
            // `q.id === \`Q-${b.id}\`` used to sit here: it compared a queue id to
            // "Q-ART-64429" and could never match. Removed, not adapted — the
            // booking link is q.bookingId.
            (q.bookingId === b.id || (q.phone && q.phone === b.customerPhone) || (q.name && q.name === b.customerName))
          );

          if (!exists) {
            const qNumber = await generateNextQueueNumber();
            // Resolve the real tutor through the booked session — no default staff member.
            const link = await resolveBookingSessionLink(b);
            const qItem: QueueItem = {
              ...EMPTY_QUEUE_COLUMNS,
              id: newQueueId(),
              queueNumber: qNumber,
              bookingId: b.id,
              name: b.customerName,
              phone: b.customerPhone,
              activity: b.workshopTitle,
              participants: b.participants,
              checkInTime: b.time || '12:00 PM',
              elapsedMinutes: 0,
              staffAvatar: '',
              staffName: link.staffName,
              staffId: link.staffId,
              status: b.status === 'Checked In' ? 'In Progress' : (b.status === 'Completed' ? 'Completed' : 'Waiting'),
              source: b.source || 'Website',
              type: 'With Instructor',
              workshopId: b.workshopId,
              sessionId: link.sessionId,
              sessionStartTime: link.startTime,
              sessionEndTime: link.endTime,
              sessionDuration: link.duration,
              sessionCapacity: link.capacity,
              date: todayRiyadh,
              history: [{ status: 'Waiting', timestamp: new Date().toISOString() }]
            };

            // Insert, not upsert: a duplicate must fail loudly. This retry has
            // existed since before 0030 and had never once fired, because
            // db.queue.put upserts and an upsert does not throw — every
            // collision it was written to catch succeeded as a silent merge of
            // two unrelated visits.
            //
            // Now it has a real job: the id is a uuid and cannot collide, but
            // two concurrent check-ins can read the same display number, and the
            // unique index on (date, queue_number) rejects the loser.
            try {
              await db.queue.add(qItem);
            } catch (addErr) {
              console.warn('Queue insert failed, retrying with a fresh number:', addErr);
              await db.queue.add({ ...qItem, id: newQueueId(), queueNumber: await generateNextQueueNumber() });
            }
          }
        }
      } catch (err) {
        console.error("Error syncing today's bookings to queue:", err);
      } finally {
        isSyncingQueueRef.current = false;
      }
    };

    syncTodayBookingsToQueue();
  }, [todayDateStr, bookings.length]);

  /**
   * Flips a booking to Checked In when its guest is seated.
   *
   * updateQueueStatus() does this when a row moves to In Progress, but
   * seatQueueItem() writes that status directly and never went through it — so
   * seating from the table picker left the booking Pending, and the no-show
   * timer would then cancel a customer sitting at a table. Shared by both
   * paths so the two cannot drift again.
   */
  const markBookingCheckedIn = async (queueItem: QueueItem) => {
    try {
      const bookings = await db.bookings.toArray();
      const wanted = normalizeCustomerPhone(queueItem.phone);

      const booking =
        bookings.find(b => queueItem.bookingId && String(b.id) === String(queueItem.bookingId)) ||
        (wanted
          ? bookings.find(b =>
              normalizeCustomerPhone(b.customerPhone) === wanted &&
              normalizeDateString(b.date) === normalizeDateString(queueItem.date)
            )
          : undefined);

      if (!booking || booking.status === 'Checked In' || booking.status === 'Completed' || booking.status === 'Cancelled') return;

      await db.bookings.update(booking.id, {
        status: 'Checked In',
        timeline: [
          ...(booking.timeline || []),
          {
            time: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
            action: 'Status updated to Checked In via Live Queue'
          }
        ]
      });
    } catch (err) {
      console.error('Failed to mark booking checked in on seating:', err);
    }
  };

  /** Returns a cancelled booking's seats, clamped to capacity, in one statement. */
  const releaseSeats = async (bookingId: string) => {
    if (!supabase || !bookingId) return;
    const { error } = await supabase.rpc('release_booking_seats', { p_booking_id: bookingId });
    if (error) console.error('Failed to release seats:', error.message);
    else notifySeatsChanged();
  };

  /**
   * The next queue number for today, from Postgres.
   *
   * The number is computed server-side so two walk-ins checked in at the same
   * moment cannot be handed the same one. The local fallback below only runs
   * when the RPC is unavailable.
   */
  /**
   * A fresh read of everything an assignment/space conflict check needs.
   *
   * Deliberately not the cached lists: the check must see a session someone
   * else saved a moment ago, or it will approve a double booking.
   */
  const getFreshAssignmentSources = async () => {
    const [staffRows, sessions, workshopRows, eventRows, queueRows, resources, settings] =
      await Promise.all([
        fetchTable<StaffMember>('staff'),
        fetchTable<WorkshopSessionRecord>('workshop_sessions'),
        fetchTable<Workshop>('workshops'),
        fetchTable<AppEvent>('events'),
        fetchTable<QueueItem>('queue'),
        fetchTable<StudioResource>('studio_resources'),
        fetchTable<AppSetting>('app_settings')
      ]);
    return {
      staff: staffRows,
      workshopSessions: sessions,
      workshops: workshopRows,
      events: eventRows,
      queue: queueRows,
      studioResources: resources,
      appSettings: settings
    };
  };

  /** Staff read straight from Postgres, for checks that must not be stale. */
  const getFreshStaff = async (): Promise<StaffMember[]> => fetchTable<StaffMember>('staff');

  /**
   * The next DISPLAY number for today. Not a key.
   *
   * Resetting daily is correct for a number staff read out; it was only ever
   * wrong as a primary key, which is what migration 0030 separated. The id is a
   * uuid minted at the call site.
   *
   * Advisory: two concurrent check-ins can read the same number. The unique
   * index on (date, queue_number) decides, and callers retry on 23505.
   */
  const generateNextQueueNumber = async (): Promise<number> => {
    const today = getRiyadhDateString();

    if (supabase) {
      const { data, error } = await supabase.rpc('next_queue_number', { p_date: today });
      if (!error && typeof data === 'number') return data;
      if (error) console.error('next_queue_number failed, numbering locally:', error.message);
    }

    // Local fallback. Reads queueNumber rather than parsing digits out of the
    // id — the id no longer contains one.
    const todaysItems = (await db.queue.toArray()).filter(qi => qi.date === today);
    const highest = todaysItems.reduce((max, qi) => Math.max(max, Number(qi.queueNumber) || 0), 0);
    return highest + 1;
  };

  /** A fresh surrogate key. Never shown; see formatQueueNumber for display. */
  const newQueueId = (): string =>
    (globalThis.crypto?.randomUUID?.() ?? `q-${Date.now()}-${Math.random().toString(16).slice(2)}`);

  /**
   * Every optional queue column, explicitly null.
   *
   * modelToRow drops `undefined`, so an omitted key is simply absent from the
   * write — and a PostgREST upsert leaves absent columns at their previous
   * values. That is exactly how a walk-in inherited an unrelated booking_id from
   * a colliding row. Spreading this first means a creation payload always states
   * every column it owns, whatever the write path does.
   */
  const EMPTY_QUEUE_COLUMNS = {
    bookingId: null, customerId: null, hours: null, tableIds: null,
    seatedTime: null, workshopId: null, sessionId: null, sessionStartTime: null,
    sessionEndTime: null, sessionDuration: null, sessionCapacity: null,
    returnedFromQueueId: null, extendedByQueueId: null, workshopType: null
  } as unknown as Partial<QueueItem>;

  // Test Running State
  const [isTestRunning, setIsTestRunning] = useState<boolean>(false);
  const [testProgress, setTestProgress] = useState<number>(0);
  const [testsPassing, setTestsPassing] = useState<boolean>(true);

  // Auto increment elapsed queue times (for visual realism)
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const items = await db.queue.toArray();
        for (const item of items) {
          if (item.status === 'Waiting' || item.status === 'In Progress') {
            await db.queue.update(item.id, { elapsedMinutes: item.elapsedMinutes + 1 });
          }
        }
      } catch (err) {
        console.error("Failed to auto-increment elapsedMinutes:", err);
      }
    }, 60000); // every minute
    return () => clearInterval(timer);
  }, []);

  // The no-show and unpaid auto-cancel timers that used to live here are gone.
  //
  // They ran in whichever browser happened to have the app open, so they
  // needed a staff session to have any authority at all — a customer's tab
  // was silently refused by RLS, and with nobody logged in they simply did
  // not run. They also could not notify anyone: send-sms requires is_staff(),
  // which a customer session can never satisfy.
  //
  // Both rules now live in the auto-cancel-bookings Edge Function, on a
  // schedule, with the service role. Same conditions, same 15-minute
  // thresholds, same Called-only no-show gate — see its logic.ts, which is
  // where they are now tested. Deliberately not duplicated here: two writers
  // on a timer would race each other and could double-notify.

  // Mutators
  const addWorkshop = async (ws: Omit<Workshop, 'id' | 'slug'>) => {
    const id = `ws-${Date.now()}`;
    const slug = ws.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const newWs: Workshop = { ...ws, id, slug };
    await db.workshops.add(newWs);

    if (ws.sessions && Array.isArray(ws.sessions)) {
      const sessionRecords = ws.sessions.map((s: any, idx: number) => ({
        id: s.id ? String(s.id) : `sess-${id}-${idx}`,
        workshopId: id,
        date: s.date,
        startTime: s.time || s.startTime,
        endTime: s.endTime,
        duration: s.duration || ws.duration,
        capacity: Number(s.capacity) || Number(ws.capacity) || 10,
        status: s.status || 'Published',
        instructor: s.instructor || ws.instructor || '',
        staffId: s.staffId || ws.staffId,
        // Stable studio-space and rule links travel with the session.
        roomId: s.roomId || ws.roomId,
        room: s.room || ws.room,
        tableId: s.tableId || ws.tableId,
        ruleId: s.ruleId
      }));
      await db.workshopSessions.bulkPut(sessionRecords);
    }
  };

  const updateWorkshop = async (id: string, updates: Partial<Workshop>) => {
    await db.workshops.update(id, updates);

    if (updates.sessions && Array.isArray(updates.sessions)) {
      const existing = await db.workshopSessions.where('workshopId').equals(id).toArray();
      const newSessionIds = new Set<string>();

      const sessionRecords = updates.sessions.map((s: any, idx: number) => {
        const sessId = s.id ? String(s.id) : `sess-${id}-${idx}`;
        newSessionIds.add(sessId);
        return {
          id: sessId,
          workshopId: id,
          date: s.date,
          startTime: s.time || s.startTime,
          endTime: s.endTime,
          duration: s.duration || updates.duration,
          capacity: Number(s.capacity) || Number(updates.capacity) || 10,
          status: s.status || 'Published',
          instructor: s.instructor || updates.instructor || '',
          staffId: s.staffId || updates.staffId,
          roomId: s.roomId || updates.roomId,
          room: s.room || updates.room,
          tableId: s.tableId || updates.tableId,
          ruleId: s.ruleId
        };
      });

      await db.workshopSessions.bulkPut(sessionRecords);

      for (const ex of existing) {
        if (!newSessionIds.has(ex.id)) {
          const activeBookingsCount = await db.bookings
            .where('workshopId').equals(id)
            .filter(b => b.date === ex.date && b.time === ex.startTime && b.status !== 'Cancelled')
            .count();
          if (activeBookingsCount === 0) {
            await db.workshopSessions.delete(ex.id);
          } else {
            await db.workshopSessions.update(ex.id, { status: 'Cancelled' });
          }
        }
      }
    } else if (updates.instructor !== undefined || updates.staffId !== undefined) {
      const existing = await db.workshopSessions.where('workshopId').equals(id).toArray();
      for (const ex of existing) {
        const sessUpdates: any = {};
        if (updates.instructor !== undefined) sessUpdates.instructor = updates.instructor;
        if (updates.staffId !== undefined) sessUpdates.staffId = updates.staffId;
        await db.workshopSessions.update(ex.id, sessUpdates);
      }
    }
  };

  const addEvent = async (evt: Omit<AppEvent, 'id' | 'spotsLeft'>) => {
    const id = `evt-${Date.now()}`;
    const newEvt: AppEvent = {
      ...evt,
      id,
      spotsLeft: evt.capacity
    };
    await db.events.add(newEvt);
  };

  const updateEvent = async (id: string, updates: Partial<AppEvent>) => {
    await db.events.update(id, updates);
  };

  const deleteEvent = async (id: string): Promise<{ success: boolean; message?: string }> => {
    const bookingsCount = await db.bookings.where('workshopId').equals(id).count();
    if (bookingsCount > 0) {
      return { success: false, message: 'Cannot delete event with existing bookings. Please cancel or archive it instead.' };
    }
    await db.events.delete(id);
    return { success: true };
  };

  /**
   * Creates a booking, resolving only once the database has accepted it.
   *
   * This used to return the locally-built Booking object immediately and write
   * in the background. The checkout screen took that object as success and
   * rendered the confirmation — confetti and all — while the insert was still
   * in flight, so a customer could be congratulated and THEN shown an error for
   * a booking that never existed. Anything that fails server-side (no seats
   * left, a full birthday slot, a network drop) hit the customer in that order.
   *
   * It now rejects if the write fails, so the caller cannot show success for a
   * booking that did not happen.
   */
  /**
   * Whether a booking is a birthday party, for the purpose of tagging the
   * customer record it creates. Deliberately the same test book_birthday_slot
   * routing uses, so the two cannot disagree about what a birthday booking is.
   */
  const isBirthdayBookingData = (b: { workshopId?: string; workshopTitle?: string }) =>
    b.workshopId === 'birthday-party-event' ||
    String(b.workshopTitle || '').toLowerCase().includes('birthday');

  const addBooking = async (
    newBookingData: Omit<Booking, 'id' | 'createdAt' | 'timeline'>,
    /**
     * Reference code to write under. Supplied by a caller that may retry, so
     * every attempt at the same booking carries the same id — which is what
     * makes the RPCs' idempotency check (migration 0028) able to tell a retry
     * from a second booking. Omitted, a fresh one is generated.
     */
    existingRefCode?: string
  ): Promise<Booking> => {
    setBookingError(null);
    const refCode = existingRefCode || generateBookingRefCode();
    const nowStr = new Date().toISOString();
    
    let pStatus: Booking['paymentStatus'] = newBookingData.paymentStatus || 'Paid';
    if (newBookingData.workshopId === 'birthday-party-event' || newBookingData.workshopTitle.toLowerCase().includes('birthday') || newBookingData.workshopTitle.toLowerCase().includes('package')) {
      if (pStatus === 'Paid') {
        pStatus = 'Deposit Paid';
      }
    }

    const newBooking: Booking = {
      ...newBookingData,
      paymentStatus: pStatus,
      status: (newBookingData.status as string === 'Confirmed' || !newBookingData.status) ? 'Pending' : newBookingData.status,
      id: refCode,
      createdAt: nowStr,
      timeline: [
        { time: nowStr.substring(11, 16), action: `Booking created via ${newBookingData.source}` },
        { time: nowStr.substring(11, 16), action: pStatus === 'Paid' || pStatus === 'Deposit Paid' ? 'Payment processed successfully' : 'Booking awaiting payment' }
      ]
    };

    // The insert and the seat check happen in one Postgres statement, with the
    // session row locked: two people taking the last seat cannot both succeed.
    // Never read capacity here and write it back.
    {
      const client = getDataClient();
      if (!client) {
        setBookingError(SUPABASE_NOT_CONFIGURED);
        throw new Error(SUPABASE_NOT_CONFIGURED);
      }

      // The customer record is resolved FIRST, so the booking carries
      // customer_id. Without it the booking is invisible to the person who
      // made it: the customer row-level policy matches on that column, so
      // My Bookings would always be empty.
      let customerId = newBookingData.customerId;
      if (!customerId && (newBookingData.customerEmail || newBookingData.customerPhone)) {
        const resolved = await resolveCustomer(
          {
            name: newBookingData.customerName,
            email: newBookingData.customerEmail,
            phone: newBookingData.customerPhone
          },
          // Only reaches a NEW customer record — an existing one keeps whatever
          // it was first filed under.
          isBirthdayBookingData(newBookingData) ? 'Birthday Package' : 'Workshop Booking'
        );
        customerId = resolved.customer?.id;
      }

      newBooking.customerId = customerId;

      const bookingRow = toRow('bookings', { ...newBooking, customerId });

      // Birthday parties are capped by date and by time slot rather than by
      // session capacity, so they take a different atomic path. Both do the
      // count and the insert in one statement — the client-side checks give a
      // good message early, this is what actually holds when two people submit
      // the last slot at the same instant.
      const isBirthdayBooking =
        newBooking.workshopId === 'birthday-party-event' ||
        String(newBooking.workshopTitle || '').toLowerCase().includes('birthday');

      // A request that never resolves is worse on a payment step than one that
      // fails: the customer cannot tell whether they were charged, cannot
      // retry, and can only force-quit the page. Nothing in the stack below
      // imposes an upper bound, so this does.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), BOOKING_WRITE_TIMEOUT_MS);
      try {
        const { error } = isBirthdayBooking
          ? await client.rpc('book_birthday_slot', {
              p_booking: bookingRow,
              // Staff may deliberately exceed the maxima — a private buyout, or a
              // party the studio has agreed to take on. The database honours this
              // only for a caller that passes is_staff(), so setting it here can
              // never let a customer through.
              p_allow_override: newBooking.source === 'Admin' || newBooking.source === 'Walk-in'
            }).abortSignal(abort.signal)
          : await client.rpc('book_session_seats', {
              p_booking: bookingRow,
              p_session_id: newBooking.sessionId || null
            }).abortSignal(abort.signal);
        if (error) {
          // Surfaced to the caller as well as stored: the checkout screen has to
          // know not to advance, which a state flag alone would not tell it in
          // time.
          console.error('Failed to add booking:', error.message);
          setBookingError(error.message || 'The booking could not be saved.');
          throw new Error(error.message);
        }
        // Seat counts come from an RPC, which is not a realtime subscription, so
        // nothing else would tell the pages showing availability that a seat has
        // just gone.
        notifySeatsChanged();
      } finally {
        clearTimeout(timer);
      }
    }

    // If walk-in or admin AND the booking is for today, automatically add to
    // today's live queue. Guarded by date: this used to fire for ANY
    // Walk-in/Admin booking regardless of its own date, which was never
    // reachable before a staff birthday booking (a future date is routine
    // there) started calling addBooking with these sources.
    if (
      (newBookingData.source === 'Walk-in' || newBookingData.source === 'Admin') &&
      normalizeDateString(newBookingData.date) === normalizeDateString(getRiyadhDateString())
    ) {
      Promise.all([generateNextQueueNumber(), resolveBookingSessionLink(newBooking)]).then(([qNumber, link]) => {
        const timeStr = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        const newQItem: QueueItem = {
          ...EMPTY_QUEUE_COLUMNS,
          id: newQueueId(),
          queueNumber: qNumber,
          bookingId: newBooking.id,
          name: newBookingData.customerName,
          phone: newBookingData.customerPhone,
          activity: newBookingData.workshopTitle,
          participants: newBookingData.participants,
          checkInTime: timeStr,
          elapsedMinutes: 0,
          staffAvatar: '',
          // Tutor comes from the booked session, not a default staff member.
          staffName: link.staffName,
          staffId: link.staffId,
          status: 'Waiting',
          source: newBookingData.source,
          type: 'With Instructor',
          workshopId: newBookingData.workshopId,
          sessionId: link.sessionId,
          sessionStartTime: link.startTime,
          sessionEndTime: link.endTime,
          sessionDuration: link.duration,
          sessionCapacity: link.capacity,
          date: getRiyadhDateString(),
          history: [{ status: 'Waiting', timestamp: new Date().toISOString() }]
        };
        db.queue.add(newQItem).catch(err => {
          console.error("Failed to add queue item in addBooking:", err);
        });
      }).catch(err => {
        console.error("Failed to generate queue ID in addBooking:", err);
      });
    }

    // A booking creates no piece. Pieces exist once a real object exists, which
    // only the studio can know — so one is logged by hand in the Pottery
    // Logging Console. Auto-creating one here put pieces on the customer's My
    // Pieces page for workshops they had not attended yet.

    return newBooking;
  };

  /**
   * Computes the refunded/not-refunded message, writes a customer
   * notification row, and fires SMS — for cancelBooking() only (booking
   * cancellation notifications). Not shared with updateQueueStatus()'s
   * separate booking-cancel-sync branch or the two automatic
   * cancellation effects — neither has a refund determination of its
   * own, and both are explicitly out of scope for this chunk.
   *
   * No time-based dedup, unlike notifyPieceStatusChange(): cancellation
   * is a one-way, terminal transition. cancelBooking()'s own
   * `booking.status !== 'Cancelled'` guard means this can never run
   * twice for the same booking once the first call's write has
   * committed — not just within a short window, the way a piece's
   * status can legitimately be re-applied later. The only theoretical
   * duplicate risk is a genuine concurrent double-click racing past
   * that guard before either write commits, which is a pre-existing
   * characteristic of cancelBooking() itself, unrelated to
   * notifications and out of this chunk's scope to address.
   */
  const notifyBookingCancellation = async (booking: Booking, refunded: boolean) => {
    const formattedDate = formatDate(booking.date, { year: 'numeric', month: 'long', day: 'numeric', timeZone: RIYADH_TIME_ZONE });
    const friendlyMsg = refunded
      ? `Your booking for "${booking.workshopTitle}" on ${formattedDate} has been cancelled, and ${booking.totalPrice} SAR has been refunded. We hope to see you again soon!`
      : `Your booking for "${booking.workshopTitle}" on ${formattedDate} has been cancelled. Per our cancellation policy, this booking was not eligible for a refund. Please contact Arty Café with any questions.`;

    // Best-effort, matching the SMS block below: notifications RLS only
    // grants INSERT to staff (notifications_staff_all) — there is no
    // customer INSERT policy, since every other notification write in
    // this codebase is reachable only from a staff session. This is the
    // one call site reachable from a customer's own session
    // (MyBookingsSection.tsx's self-cancel), so it's the one write that
    // can genuinely fail on RLS rather than a network blip — caught here
    // rather than left to throw uncaught up through cancelBooking()
    // (called unawaited, with no .catch(), from that page's onClick),
    // which silently broke the whole cancellation from the UI's
    // perspective even though the transaction above had already
    // committed successfully.
    try {
      await db.notifications.add({
        id: `NOTIF-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        type: 'customer',
        customerPhone: booking.customerPhone,
        title: refunded ? 'Booking Cancelled — Refunded' : 'Booking Cancelled',
        message: friendlyMsg,
        timestamp: new Date().toISOString(),
        isRead: false,
        highlighted: false
      });
    } catch (err: any) {
      console.error(`notifyBookingCancellation: in-app notification for booking ${booking.id} failed:`, err?.message || err);
    }

    // SMS — same established pattern as notifyPieceStatusChange():
    // fire-and-forget, phone passed through unnormalized (send-sms's
    // shared helper normalizes it), failures logged only, never thrown,
    // never blocking cancelBooking()'s own already-committed writes.
    if (!booking.customerPhone) {
      console.error(`notifyBookingCancellation: SMS for booking ${booking.id} not sent — no phone number on file.`);
      return;
    }
    const smsClient = supabaseStaff;
    if (!smsClient) {
      console.error(`notifyBookingCancellation: SMS for booking ${booking.id} not sent — staff client not configured.`);
      return;
    }
    (async () => {
      try {
        // Always English then Arabic, whatever the customer's language
        // preference — the same shared template the Edge Functions use. The
        // in-app notification above keeps friendlyMsg.
        const smsText = bookingCancellationSms(refunded ? 'refunded' : 'notRefunded', {
          workshopTitle: booking.workshopTitle,
          date: booking.date,
          amount: booking.totalPrice
        });
        const { data: smsData, error: smsError } = await smsClient.functions.invoke('send-sms', {
          body: { phone: booking.customerPhone, message: smsText }
        });
        if (smsError) {
          let reason = smsError.message || 'unknown error';
          if (smsError instanceof FunctionsHttpError) {
            try {
              const body = await smsError.context.json();
              reason = (body as { error?: string })?.error || reason;
            } catch {
              /* keep the generic reason */
            }
          }
          console.error(`notifyBookingCancellation: SMS for booking ${booking.id} failed:`, reason);
        } else if (!(smsData as { success?: boolean })?.success) {
          console.error(`notifyBookingCancellation: SMS for booking ${booking.id} was not confirmed sent:`, (smsData as { error?: string })?.error);
        }
      } catch (err: any) {
        console.error(`notifyBookingCancellation: SMS for booking ${booking.id} failed:`, err?.message || err);
      }
    })();
  };

  const cancelBooking = async (id: string, user: string = 'Staff', paymentStatusUpdate?: 'Refunded' | 'Paid' | 'Unpaid' | 'Deposit Paid') => {
    const booking = await db.bookings.get(id);
    if (booking && booking.status !== 'Cancelled') {
      // Staff choose the refund outcome explicitly; whatever they pick is
      // written verbatim, with no 24-hour-policy override in either direction.
      const finalPaymentStatus: Booking['paymentStatus'] = paymentStatusUpdate || booking.paymentStatus;
      const actionMsg = `Booking cancelled by ${user}` +
        (finalPaymentStatus === 'Refunded' ? ' — Refunded' : ' — Not refunded');

      const nowStr = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const nowIso = new Date().toISOString();

      await db.transaction('rw', db.bookings, db.queue, db.workshops, async () => {
        await db.bookings.update(id, {
          status: 'Cancelled',
          paymentStatus: finalPaymentStatus,
          timeline: [...booking.timeline, { time: nowStr, action: actionMsg }]
        });

        // Find linked queue entry by bookingId or fallback matching
        let queueEntry = await db.queue.where('bookingId').equals(id).first();
        if (!queueEntry) {
          const allQueue = await db.queue.toArray();
          queueEntry = allQueue.find(q => 
            q.bookingId === id || 
            q.id === `Q-${id}` || 
            (q.phone && q.phone === booking.customerPhone && q.date === booking.date && q.name === booking.customerName)
          );
        }

        if (queueEntry && queueEntry.status !== 'Completed' && queueEntry.status !== 'In Progress' && queueEntry.status !== 'Called') {
          await db.queue.update(queueEntry.id, {
            status: 'Cancelled',
            history: [...(queueEntry.history || []), { status: 'Cancelled', timestamp: nowIso }]
          });
        }

        // Seats go back in one clamped Postgres statement.
        await releaseSeats(booking.id);
      });

      await notifyBookingCancellation(booking, finalPaymentStatus === 'Refunded');
    }
  };

  /**
   * A customer cancelling their own booking.
   *
   * cancelBooking() above is a staff path: it writes `bookings` directly, which
   * a customer session cannot do — RLS grants them SELECT only, and the blocked
   * UPDATE returned an empty result that read as success, so the page confirmed
   * a cancellation that never happened. This goes through cancel_own_booking
   * (migration 0017), which proves ownership from auth.uid(), applies the same
   * 24-hour refund rule, releases the seats through the same RPC, and appends
   * the same kind of timeline entry.
   *
   * The in-app notification and SMS do NOT go through notifyBookingCancellation()
   * (used by the staff path above) — that helper's in-app insert always failed
   * silently under RLS for a customer session (no notifications_customer_insert
   * policy, deliberately — see migration 0031), and its SMS call goes through
   * supabaseStaff, a client with no session at all for a customer. The
   * notification is now written server-side inside cancel_own_booking itself
   * (migration 0031); SMS goes through notify-own-booking, a narrowly-scoped
   * Edge Function that proves ownership of this specific booking rather than
   * staff status.
   */
  const cancelOwnBooking = async (id: string): Promise<{ success: boolean; error?: string; refunded?: boolean }> => {
    if (!supabase) {
      return { success: false, error: 'Cancellation is unavailable right now. Please contact the studio.' };
    }

    const { data, error } = await supabase.rpc('cancel_own_booking', { p_booking_id: id });

    if (error) {
      console.error(`cancelOwnBooking: booking ${id} failed:`, error.message);
      return { success: false, error: 'We could not cancel that booking. Please try again or contact the studio.' };
    }
    notifySeatsChanged();

    // The function returns a single row; PostgREST hands back an array for a
    // table-returning function.
    const result = (Array.isArray(data) ? data[0] : data) as
      | { success: boolean; code: string; reason: string | null; refunded: boolean }
      | undefined;

    if (!result?.success) {
      return { success: false, error: result?.reason || 'That booking could not be cancelled.' };
    }

    // Fire-and-forget, matching notifyBookingCancellation()'s own SMS block:
    // failures are logged, never thrown, never undoing a cancellation that has
    // already committed. The in-app notification already happened inside the
    // RPC above — nothing left to do for it here.
    (async () => {
      try {
        const { data: notifyData, error: notifyError } = await supabase.functions.invoke('notify-own-booking', {
          body: { bookingId: id }
        });
        if (notifyError) {
          let reason = notifyError.message || 'unknown error';
          if (notifyError instanceof FunctionsHttpError) {
            try {
              const errBody = await notifyError.context.json();
              reason = (errBody as { error?: string })?.error || reason;
            } catch {
              /* keep the generic reason */
            }
          }
          console.error(`cancelOwnBooking: SMS for booking ${id} failed:`, reason);
        } else if (!(notifyData as { success?: boolean })?.success) {
          console.error(`cancelOwnBooking: SMS for booking ${id} was not confirmed sent:`, (notifyData as { error?: string })?.error);
        }
      } catch (err: any) {
        console.error(`cancelOwnBooking: SMS for booking ${id} failed:`, err?.message || err);
      }
    })();

    return { success: true, refunded: result.refunded };
  };

  /**
   * Adds a workshop/event category unless one with that name already exists.
   * The comparison is case-insensitive, so "Pottery" typed again never creates
   * a second row. Used by both Publish and Save Draft.
   */
  /**
   * Assigns (or clears) the staff member hosting a birthday/event booking.
   *
   * Stores the stable id with the name denormalised beside it, exactly as a
   * workshop session does, and records the change on the booking's timeline.
   * Passing null clears the assignment.
   */
  const assignBookingStaff = async (bookingId: string, staffId: string | null) => {
    if (!bookingId) return { success: false, error: 'No booking selected.' };

    const member = staffId ? (await fetchTable<StaffMember>('staff')).find(m => m.id === staffId) : null;
    if (staffId && !member) return { success: false, error: 'That staff member no longer exists.' };

    try {
      await db.bookings.update(bookingId, {
        staffId: staffId || null,
        staffName: member?.name || null,
        updatedAt: new Date().toISOString()
      } as any);

      await appendBookingTimeline(
        bookingId,
        member ? `Assigned to ${member.name}` : 'Staff assignment cleared'
      );
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Could not save the assignment.' };
    }
  };

  const addCategoryIfMissing = async (name: string): Promise<{ created: boolean; id?: string }> => {
    const clean = String(name || '').trim();
    if (!clean) return { created: false };

    const all = await db.categories.toArray();
    const existing = all.find(c => String(c.name || '').trim().toLowerCase() === clean.toLowerCase());
    if (existing) return { created: false, id: existing.id };

    const id = `cat-${Date.now()}`;
    await db.categories.add({ id, name: clean });
    return { created: true, id };
  };

  /**
   * Sets (or clears, with null) the optional Arabic display name of one category.
   * Writes name_ar and nothing else: the English `name` is what workshops are
   * matched on, so this deliberately cannot touch name or id.
   */
  const updateCategoryNameAr = async (id: string, nameAr: string | null) => {
    const clean = typeof nameAr === 'string' ? nameAr.trim() : '';
    await db.categories.update(id, { nameAr: clean || null });
  };

  /**
   * Updates one workshop session. Kept as a mutator so session writes go
   * through the data layer rather than straight to the table.
   */
  const updateWorkshopSession = async (id: string, updates: Partial<WorkshopSessionRecord>) => {
    if (!id) return;
    await db.workshopSessions.update(String(id), { ...updates, updatedAt: new Date().toISOString() });
  };

  /**
   * Appends one entry to a booking's timeline, preserving what is already
   * there. Every booking write keeps its own audit trail this way.
   */
  const appendBookingTimeline = async (bookingId: string, action: string) => {
    if (!bookingId || !action) return;
    const booking = await db.bookings.get(String(bookingId));
    if (!booking) return;

    const nowStr = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    await db.bookings.update(booking.id, {
      timeline: [...(booking.timeline || []), { time: nowStr, action }]
    });
  };

  const updateBookingStatus = async (id: string, status: Booking['status'], paymentStatus?: Booking['paymentStatus'], user: string = 'Staff') => {
    const booking = await db.bookings.get(id);
    if (booking) {
      const nowStr = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const newTimeline = [...booking.timeline, { time: nowStr, action: `Status updated to ${status} by ${user}` }];
      if (paymentStatus && paymentStatus !== booking.paymentStatus) {
        newTimeline.push({ time: nowStr, action: `Payment updated to ${paymentStatus} by ${user}` });
      }

      await db.bookings.update(id, {
        status,
        paymentStatus: paymentStatus || booking.paymentStatus,
        timeline: newTimeline
      });

      // If booking status becomes 'Checked In', sync it to the live queue list
      if (status === 'Checked In') {
        const queueItems = await db.queue.toArray();
        const alreadyInQueue = queueItems.some(q => q.name === booking.customerName && q.status !== 'Completed');
        if (!alreadyInQueue) {
          const qNumber = await generateNextQueueNumber();
          const link = await resolveBookingSessionLink(booking);
          const timeStr = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
          const qItem: QueueItem = {
            ...EMPTY_QUEUE_COLUMNS,
            id: newQueueId(),
            queueNumber: qNumber,
            bookingId: booking.id,
            name: booking.customerName,
            phone: booking.customerPhone,
            activity: booking.workshopTitle,
            participants: booking.participants,
            checkInTime: timeStr,
            elapsedMinutes: 0,
            staffAvatar: '',
            staffName: link.staffName,
            staffId: link.staffId,
            status: 'Waiting',
            source: booking.source,
            type: 'With Instructor',
            workshopId: booking.workshopId,
            sessionId: link.sessionId,
            sessionStartTime: link.startTime,
            sessionEndTime: link.endTime,
            sessionDuration: link.duration,
            sessionCapacity: link.capacity,
            date: getRiyadhDateString(),
            history: [{ status: 'Waiting', timestamp: new Date().toISOString() }]
          };
          await db.queue.put(qItem);
        }
      }
    }
  };

  /**
   * Raises a staff notification. Same table and shape the pottery pipeline
   * uses, exposed so pages never write to the notifications table themselves.
   */
  const addStaffNotification = async (
    title: string,
    message: string,
    meta: { newStatus?: string; performedBy?: string; highlighted?: boolean } = {}
  ) => {
    try {
      await db.notifications.add({
        id: `NOTIF-STAFF-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        type: 'staff',
        title,
        message,
        newStatus: meta.newStatus,
        performedBy: meta.performedBy || 'System',
        timestamp: new Date().toISOString(),
        isRead: false,
        highlighted: meta.highlighted === true
      } as NotificationItem);
    } catch (err) {
      console.error('Failed to raise staff notification:', err);
    }
  };

  /**
   * Reads the configured café tables and every active queue entry fresh from
   * the database, so a table-capacity check is never made against a stale
   * in-memory snapshot — the same reason `validateBookingForm` re-reads
   * session capacity at submit time.
   */
  const loadTableCapacitySources = async (excludeQueueId?: string) => {
    const [settings, allQueue] = await Promise.all([db.appSettings.toArray(), db.queue.toArray()]);
    const tables = getConfiguredTables(settings);
    const states = computeTableStates(tables, allQueue, {
      excludeQueueId,
      todayDateStr: getRiyadhDateString()
    });
    return { tables, states };
  };

  const addQueueItem = async (
    item: Omit<QueueItem, 'id' | 'checkInTime' | 'elapsedMinutes' | 'status' | 'date' | 'history'>
  ): Promise<{ success: boolean; error?: string }> => {
    // Table assignment at check-in is entirely optional (Waiting needs no
    // table), but a table picked up-front must still be genuinely free.
    if (item.tableIds && item.tableIds.length > 0) {
      const { states } = await loadTableCapacitySources();
      const check = validateTableSelection(item.tableIds, item.participants, states);
      if (!check.valid) return { success: false, error: check.error };
    }

    const todayRiyadh = getRiyadhDateString();
    const timeStr = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

    // EMPTY_QUEUE_COLUMNS first, so every optional column is stated even when
    // the caller omits it. This is the path that inherited a stranger's
    // booking_id before 0030.
    const base: QueueItem = {
      ...EMPTY_QUEUE_COLUMNS,
      ...item,
      id: newQueueId(),
      queueNumber: await generateNextQueueNumber(),
      checkInTime: timeStr,
      elapsedMinutes: 0,
      status: 'Waiting',
      date: todayRiyadh,
      history: [{ status: 'Waiting', timestamp: new Date().toISOString() }]
    } as QueueItem;

    try {
      await db.queue.add(base);
    } catch (addErr) {
      // Another check-in took this number between the read and the write.
      console.warn('Queue insert failed, retrying with a fresh number:', addErr);
      try {
        await db.queue.add({ ...base, id: newQueueId(), queueNumber: await generateNextQueueNumber() });
      } catch (retryErr: any) {
        return { success: false, error: retryErr?.message || 'Could not check in this guest.' };
      }
    }
    // A With Instructor walk-in consumes a seat on a real workshop session;
    // seat counts come from an RPC, not a realtime subscription, so nothing
    // else would tell a customer's open workshop page that a seat just went.
    notifySeatsChanged();
    return { success: true };
  };

  /** Assigns or clears table(s) on a Waiting/Called entry — reserved capacity only. */
  const assignQueueTables = async (
    id: string, tableIds: string[]
  ): Promise<{ success: boolean; error?: string }> => {
    const item = await db.queue.get(id);
    if (!item) return { success: false, error: 'Queue entry not found.' };

    if (tableIds.length > 0) {
      const { states } = await loadTableCapacitySources(id);
      const check = validateTableSelection(tableIds, item.participants, states);
      if (!check.valid) return { success: false, error: check.error };
    }

    await db.queue.update(id, { tableIds });
    return { success: true };
  };

  /** Moves a Without Instructor entry to In Progress. A table is required. */
  const seatQueueItem = async (
    id: string, tableIds: string[]
  ): Promise<{ success: boolean; error?: string }> => {
    const item = await db.queue.get(id);
    if (!item) return { success: false, error: 'Queue entry not found.' };
    if (!tableIds || tableIds.length === 0) {
      return { success: false, error: 'Select at least one table before seating this guest.' };
    }

    const { states } = await loadTableCapacitySources(id);
    const check = validateTableSelection(tableIds, item.participants, states);
    if (!check.valid) return { success: false, error: check.error };

    await db.queue.update(id, {
      tableIds,
      status: 'In Progress',
      seatedTime: new Date().toISOString(),
      history: [...(item.history || []), { status: 'In Progress', timestamp: new Date().toISOString() }]
    });

    // Seating is a check-in. This path writes In Progress straight to the queue
    // rather than going through updateQueueStatus(), so without this the
    // booking stayed Pending and a guest sitting at a table was still exposed
    // to the no-show timer.
    await markBookingCheckedIn({ ...item, tableIds, status: 'In Progress' });

    return { success: true };
  };

  /** Moves an In Progress entry's seating to a different set of table(s). */
  const changeQueueItemTables = async (
    id: string, tableIds: string[]
  ): Promise<{ success: boolean; error?: string }> => {
    const item = await db.queue.get(id);
    if (!item) return { success: false, error: 'Queue entry not found.' };
    if (!tableIds || tableIds.length === 0) {
      return { success: false, error: 'Select at least one table.' };
    }

    const { states } = await loadTableCapacitySources(id);
    const check = validateTableSelection(tableIds, item.participants, states);
    if (!check.valid) return { success: false, error: check.error };

    await db.queue.update(id, { tableIds });
    return { success: true };
  };

  const updateQueueStatus = async (id: string, status: QueueItem['status']) => {
    const item = await db.queue.get(id);
    if (item) {
      const todayRiyadh = getRiyadhDateString();
      const updates: Partial<QueueItem> = {
        status,
        date: todayRiyadh,
        history: [...(item.history || []), { status, timestamp: new Date().toISOString() }]
      };
      if (status === 'In Progress') {
        updates.seatedTime = new Date().toISOString();
      }
      // Completing or cancelling releases every table this entry held —
      // reserved or occupied — so it cannot leave a table stuck unavailable.
      if (status === 'Completed' || status === 'Cancelled') {
        updates.tableIds = [];
      }
      await db.queue.update(id, updates);

      // Sync status to matching booking in db.bookings
      try {
        // The booking link is item.bookingId, and always was. This used to try
        // `b.id === id` and `b.id === id.replace('Q-','')` first — comparing an
        // ART-NNNNN booking id to a queue id and to a bare number. Neither could
        // ever match, so every status sync fell through to the phone-and-date
        // guess below, which picks an arbitrary booking when a customer has two
        // that day. With a uuid id those comparisons are not merely dead but
        // absurd, so they are gone.
        const allBookings = await db.bookings.toArray();
        const matchingBooking = allBookings.find(b =>
          (item.bookingId && b.id === item.bookingId) ||
          (!item.bookingId && b.customerPhone === item.phone && b.date === todayRiyadh)
        );
        if (matchingBooking) {
          let bStatus: Booking['status'] = matchingBooking.status;
          if (status === 'In Progress') bStatus = 'Checked In';
          else if (status === 'Completed') bStatus = 'Completed';
          else if (status === 'Cancelled') bStatus = 'Cancelled';
          
          await db.bookings.update(matchingBooking.id, { 
            status: bStatus,
            timeline: [...(matchingBooking.timeline || []), {
              time: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
              action: `Status updated to ${bStatus} via Live Queue`
            }]
          });
        }
      } catch (err) {
        console.error("Error syncing queue status to booking:", err);
      }

      // The matcher above compares raw phone strings and looks for a booking id
      // equal to the queue id, which almost never holds — so it can silently
      // miss. Seating is the case where a miss is harmful (the guest stays
      // Pending and the no-show timer can cancel them), so it gets a second,
      // reliable pass. Idempotent: it returns early if the booking is already
      // Checked In.
      if (status === 'In Progress') {
        await markBookingCheckedIn({ ...item, status: 'In Progress' });
      }
    }
  };

  const updateQueueItem = async (id: string, updates: Partial<QueueItem>) => {
    await db.queue.update(id, updates);
  };

  /**
   * "Add Time" — continues a completed self-guided guest for more time. The
   * completed record is left intact — a new entry is created and linked to
   * it, so history is preserved and no duplicate active entry appears. The
   * continued session is already seated, so — table(s) chosen — it goes
   * straight to In Progress rather than back through Waiting.
   */
  const returnQueueItemToWaiting = async (
    id: string,
    opts: { hours: number; participants: number; tableIds: string[] }
  ): Promise<{ success: boolean; message?: string; newId?: string }> => {
    const original = await db.queue.get(id);
    if (!original) return { success: false, message: 'Queue entry not found' };

    if (original.type !== 'Without Instructor') {
      return { success: false, message: 'Only self-guided (Without Instructor) sessions can be returned to Waiting.' };
    }
    if (original.status !== 'Completed') {
      return { success: false, message: 'Only completed sessions can be returned to Waiting.' };
    }

    const hours = Number(opts.hours);
    const participants = Number(opts.participants);
    if (!Number.isFinite(hours) || hours <= 0) {
      return { success: false, message: 'Additional hours must be a positive number.' };
    }
    if (!Number.isFinite(participants) || participants <= 0 || !Number.isInteger(participants)) {
      return { success: false, message: 'Guests must be a whole number of at least 1.' };
    }
    if (!opts.tableIds || opts.tableIds.length === 0) {
      return { success: false, message: 'Select at least one table — keep the current one or choose a different one.' };
    }

    const todayRiyadh = getRiyadhDateString();

    // Guard against a duplicate active entry for the same guest.
    const activeDuplicate = (await db.queue.toArray()).find(q =>
      q.date === todayRiyadh &&
      q.id !== original.id &&
      q.phone === original.phone &&
      q.status !== 'Completed' &&
      q.status !== 'Cancelled'
    );
    if (activeDuplicate) {
      return {
        success: false,
        message: `${original.name} already has an active queue entry (No. ${formatQueueNumber(activeDuplicate.queueNumber)}).`
      };
    }

    // The original completed entry holds no capacity, so it never needs
    // excluding here — only its own (already-released) tables could clash.
    const { states } = await loadTableCapacitySources();
    const check = validateTableSelection(opts.tableIds, participants, states);
    if (!check.valid) return { success: false, message: check.error };

    const newId = newQueueId();
    const timeStr = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const nowIso = new Date().toISOString();

    // Spread from `original` deliberately — an extension inherits the visit's
    // details. That is the one place inheriting columns is intended, unlike the
    // upsert-collision inheritance 0030 removed.
    await db.queue.add({
      ...original,
      id: newId,
      queueNumber: await generateNextQueueNumber(),
      participants,
      hours,
      tableIds: opts.tableIds,
      activity: `Walk-in (No Instructor - ${hours} hrs, extended)`,
      checkInTime: timeStr,
      elapsedMinutes: 0,
      seatedTime: nowIso,
      status: 'In Progress',
      date: todayRiyadh,
      returnedFromQueueId: original.id,
      extendedByQueueId: undefined,
      history: [
        { status: 'Waiting', timestamp: nowIso },
        { status: 'In Progress', timestamp: nowIso }
      ]
    });

    // Additive pointer only — the completed session record itself is untouched.
    await db.queue.update(original.id, { extendedByQueueId: newId });

    return { success: true, newId };
  };

  const reorderQueue = async (newQueue: QueueItem[]) => {
    await db.queue.clear();
    await db.queue.bulkAdd(newQueue);
  };

  /**
   * Computes the customer-facing message for a status, applies the
   * notifyCustomer/dedup gates, writes both notification rows (customer
   * + staff), and fires SMS for the statuses that have it wired (Ready
   * for Pickup, Broken, Created, First Burn and Colored — Collected
   * stays in-app-only, unchanged). Shared by updatePieceStatus() and
   * addPiece(): a piece's very first status, set at creation, never
   * goes through updatePieceStatus() (addPiece() inserts it directly —
   * see the SMS Chunk 4 diagnostic), so both callers go through this
   * exact same logic rather than addPiece() reimplementing it.
   *
   * Deliberately does NOT touch piece_history — each caller already
   * writes its own entry with its own correct reason text
   * (addPiece()'s "Piece manually logged or initialized" vs.
   * updatePieceStatus()'s caller-supplied reason); a second write here
   * would either duplicate or contradict that.
   */
  const notifyPieceStatusChange = async (
    // Narrowed to exactly the fields this function reads, not the full
    // PotteryPiece — so markPieceCollected() (SMS integration, Chunk 6.5)
    // can call this with the same display-fields-only shape it already
    // receives from its caller, without needing a fresh db.pieces.get()
    // that RLS would refuse for a caller without pieces-admin (see
    // markPieceCollected()'s own doc comment). A full PotteryPiece (what
    // updatePieceStatus() and addPiece() already pass) still satisfies
    // this structurally — narrowing only widens what's accepted.
    piece: Pick<PotteryPiece, 'id' | 'name' | 'pieceCode' | 'customerName' | 'customerPhone' | 'expectedReadyDate'>,
    status: PotteryPiece['status'],
    performerUser: string = 'Staff',
    reason?: string,
    // Which 'First Burn and Colored' message to send; ignored for other
    // statuses, and 'kiln' when not given.
    smsVariant?: KilnSmsVariant
  ) => {
    // Generate CUSTOMER notification. The text comes from pieceSmsTemplates.ts:
    // the bell stores its English (notificationText.ts renders the Arabic from
    // the same template), and the SMS sends English + Arabic together. Broken
    // states the outcome plainly, never the internal damage note.
    const pieceText = pieceStatusText(status, piece.pieceCode || piece.id, smsVariant);
    const friendlyMsg = pieceText?.en ?? `Your piece "${piece.name}" has been updated to "${status}".`;

    // Stages can be configured not to notify the customer at all.
    const stageConfig = (await db.pipelineStages.toArray()).find(x => x.name === status);
    if (stageConfig && stageConfig.notifyCustomer === false) {
      return;
    }

    // Exactly one customer notification per status change for this piece.
    // A brand-new piece's id has never appeared in a notification before
    // (ids are never reused — see allocatePieceIdentifier's own taken-set
    // check), so this can only ever find 0 rows for addPiece()'s call —
    // it cannot suppress a piece's very first notification.
    const alreadyNotified = await db.notifications
      .filter(n =>
        n.type === 'customer' &&
        n.pieceId === piece.id &&
        n.newStatus === status &&
        // Same change, re-applied within a short window.
        Date.now() - new Date(n.timestamp).getTime() < 60 * 1000
      )
      .count();

    if (alreadyNotified > 0) {
      return;
    }

    // Exactly one customer notification, addressed to this piece's customer.
    await db.notifications.add({
      id: `NOTIF-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      type: 'customer',
      customerPhone: piece.customerPhone,
      title: status === 'Ready for Pickup'
        ? 'Piece Ready for Pickup!'
        : status === 'Broken'
          ? `Piece ${piece.pieceCode || piece.id} marked as broken`
          // Display label: 'First Burn and Colored' reads "Kiln Time".
          : `Piece Status Update: ${enumLabel('pieceStatus', status, 'en')}`,
      message: friendlyMsg,
      pieceId: piece.id,
      pieceName: piece.name,
      newStatus: status,
      timestamp: new Date().toISOString(),
      isRead: false,
      highlighted: status === 'Ready for Pickup'
    });

    // Generate STAFF notification
    await db.notifications.add({
      id: `NOTIF-STAFF-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      type: 'staff',
      title: status === 'Ready for Pickup'
        ? 'Piece Ready for Pickup Alert'
        : status === 'Broken'
          ? 'Piece Marked Broken'
          : 'Piece Status Shifted',
      message: `Piece ${piece.id} (${piece.customerName}) moved to "${status}" by ${performerUser}.${reason ? ` Reason: ${reason}` : ''}`,
      pieceId: piece.id,
      pieceName: piece.name,
      newStatus: status,
      performedBy: performerUser,
      timestamp: new Date().toISOString(),
      isRead: false,
      highlighted: status === 'Ready for Pickup'
    });

    // SMS (SMS integration, Chunk 3 + 4 + 6) — every status now:
    // Ready for Pickup, Broken, Created, First Burn and Colored, and
    // Collected. Gated behind the exact same notifyCustomer/dedup
    // checks above: this code only runs once both
    // of those early-returns have already been passed, so a suppressed
    // stage or a duplicate call within 60s never sends a text either —
    // there is no separate SMS-specific guard that could drift out of
    // sync with the in-app one. Reuses friendlyMsg as-is (no separate
    // SMS copy to keep in sync) and passes the phone through
    // unnormalized — send-sms's own shared helper already normalizes
    // it, same as sendPickupReminder().
    //
    // Deliberately not awaited: both of this helper's callers
    // (updatePieceStatus(), and addPiece() as of this chunk) are awaited
    // by their own callers before showing a status-change toast that
    // doesn't display any SMS outcome — that toast should not wait on an
    // SMS round-trip whose result it can't show. The status change and
    // both notification writes above have already committed regardless
    // of what happens next; failures here are logged, never thrown,
    // never surfaced as a rolled-back status change.
    if (
      status === 'Ready for Pickup' || status === 'Broken' ||
      status === 'Created' || status === 'First Burn and Colored' ||
      status === 'Collected'
    ) {
      if (!piece.customerPhone) {
        console.error(`notifyPieceStatusChange: SMS for piece ${piece.id} (${status}) not sent — no phone number on file.`);
      } else {
        const smsClient = supabaseStaff;
        if (!smsClient) {
          console.error(`notifyPieceStatusChange: SMS for piece ${piece.id} (${status}) not sent — staff client not configured.`);
        } else {
          (async () => {
            try {
              // Always English then Arabic, whatever the customer's language preference.
              const smsText = pieceText ? bilingualSms(pieceText) : friendlyMsg;
              const { data: smsData, error: smsError } = await smsClient.functions.invoke('send-sms', {
                body: { phone: piece.customerPhone, message: smsText }
              });
              if (smsError) {
                let reason = smsError.message || 'unknown error';
                if (smsError instanceof FunctionsHttpError) {
                  try {
                    const body = await smsError.context.json();
                    reason = (body as { error?: string })?.error || reason;
                  } catch {
                    /* keep the generic reason */
                  }
                }
                console.error(`notifyPieceStatusChange: SMS for piece ${piece.id} (${status}) failed:`, reason);
              } else if (!(smsData as { success?: boolean })?.success) {
                console.error(`notifyPieceStatusChange: SMS for piece ${piece.id} (${status}) was not confirmed sent:`, (smsData as { error?: string })?.error);
              }
            } catch (err: any) {
              console.error(`notifyPieceStatusChange: SMS for piece ${piece.id} (${status}) failed:`, err?.message || err);
            }
          })();
        }
      }
    }
  };

  const updatePieceStatus = async (id: string, status: PotteryPiece['status'], performerUser: string = 'Staff', reason?: string, smsVariant?: KilnSmsVariant) => {
    const piece = await db.pieces.get(id);
    if (piece) {
      const historyEntry = {
        status,
        timestamp: new Date().toISOString(),
        // Riyadh-local stamp alongside the ISO timestamp
        riyadhTime: `${getRiyadhDateString()} ${getRiyadhNow().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`,
        user: performerUser,
        reason: reason || undefined
      };
      const pieceUpdates: Partial<PotteryPiece> = { status };
      // Broken keeps the internal damage note on the piece; it never leaves the console.
      if (status === 'Broken' && reason) {
        pieceUpdates.damageNote = reason;
      }
      await db.pieces.update(id, pieceUpdates);

      // History is its own append-only table now, so the trail cannot be
      // overwritten by a concurrent update the way a JSON column could.
      await db.pieceHistory.add({ pieceId: id, ...historyEntry });

      await notifyPieceStatusChange(piece, status, performerUser, reason, smsVariant);
    }
  };

  /**
   * Allocates an identifier that no piece is already using.
   *
   * The old generator picked a number out of a 700-wide range and hoped — which
   * is how the board ended up showing AC-1806 twice. This reads the codes in
   * use first, and falls back to a timestamp suffix if the random space is
   * somehow exhausted, so it always terminates with something unique.
   */
  const allocatePieceIdentifier = async (prefix: string, taken: Set<string>) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = `${prefix}-${Math.floor(1000 + Math.random() * 9000)}`;
      if (!taken.has(candidate.toUpperCase())) return candidate;
    }
    return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
  };

  const addPiece = async (piece: Omit<PotteryPiece, 'id' | 'daysElapsed' | 'expectedCompletion' | 'notes'> & Partial<Pick<PotteryPiece, 'expectedCompletion' | 'notes'>>) => {
    // Read once, check both the id and the piece code against it: the two share
    // a namespace on screen, where a piece falls back to its id when it has no
    // code of its own.
    const existing = await db.pieces.toArray();
    const taken = new Set<string>();
    existing.forEach(p => {
      if (p.id) taken.add(p.id.trim().toUpperCase());
      if (p.pieceCode) taken.add(p.pieceCode.trim().toUpperCase());
    });

    const id = await allocatePieceIdentifier('PC', taken);
    taken.add(id.toUpperCase());

    const requestedCode = piece.pieceCode?.trim();
    if (requestedCode && taken.has(requestedCode.toUpperCase())) {
      // The console checks this before calling, so reaching here means two
      // people logged the same code at once. Refusing beats silently writing a
      // duplicate.
      throw new Error(`Piece code "${requestedCode}" is already in use.`);
    }

    const newPiece: PotteryPiece = {
      name: 'Ceramic Piece',
      workshopName: 'Freestyle Handbuilding',
      customerName: 'Walk-in Customer',
      customerPhone: '+966500000000',
      image: '',
      dateCreated: new Date().toISOString().split('T')[0],
      assignedStaff: 'Lina',
      ...piece,
      // Never a legacy or hand-typed stage name — the column's check constraint
      // only accepts the six current ones.
      status: migrateLegacyPieceStatus(piece.status),
      pieceCode: requestedCode || (await allocatePieceIdentifier('AC', taken)),
      id,
      daysElapsed: 0
    };
    await db.pieces.add(newPiece);

    // The opening history entry, in the append-only table.
    await db.pieceHistory.add({
      pieceId: id,
      status: newPiece.status,
      timestamp: new Date().toISOString(),
      riyadhTime: `${getRiyadhDateString()} ${getRiyadhNow().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`,
      user: 'Staff',
      reason: 'Piece manually logged or initialized'
    });

    // A piece's initial status (Created, in practice today) never goes
    // through updatePieceStatus() — this is the only place it's ever
    // set — so the notification/SMS pipeline is invoked here directly,
    // via the same shared helper updatePieceStatus() uses. Does not
    // duplicate the piece_history entry above; the helper only handles
    // notifications and SMS.
    await notifyPieceStatusChange(newPiece, newPiece.status);
  };

  const updatePiece = async (id: string, updates: Partial<PotteryPiece>) => {
    await db.pieces.update(id, updates);
  };

  const markNotificationAsRead = async (id: string) => {
    await db.notifications.update(id, { isRead: true });
  };

  const clearAllNotifications = async (type?: 'customer' | 'staff') => {
    if (type) {
      const items = await db.notifications.where('type').equals(type).toArray();
      const keys = items.map(item => item.id);
      await db.notifications.bulkDelete(keys);
    } else {
      await db.notifications.clear();
    }
  };

  const runAllTests = () => {
    setIsTestRunning(true);
    setTestProgress(0);
    
    // Simulate test suite running with loading progress bar
    const interval = setInterval(() => {
      setTestProgress(prev => {
        if (prev >= 100) {
          clearInterval(interval);
          setIsTestRunning(false);
          return 100;
        }
        return prev + 10;
      });
    }, 150);
  };

  /**
   * Left as a no-op: it faked a failure in the old hardcoded test list, which
   * was replaced by the real suite in utils/systemTests. There is no
   * system_tests table — results come from actually running the tests. Kept so
   * the context contract is unchanged.
   */
  const toggleTestResult = async (_id: string) => {
    /* results are produced by running the suite, not toggled */
  };

  // Pipeline Stages Mutators
  const addPipelineStage = async (stage: Omit<PipelineStage, 'id' | 'order'>) => {
    const all = await db.pipelineStages.toArray();
    const order = all.length > 0 ? Math.max(...all.map(s => s.order)) + 1 : 0;
    const id = `stage-${Date.now()}`;
    await db.pipelineStages.add({ ...stage, id, order });
  };

  const updatePipelineStage = async (id: string, updates: Partial<PipelineStage>) => {
    await db.pipelineStages.update(id, updates);
  };

  const deletePipelineStage = async (id: string) => {
    const stage = await db.pipelineStages.get(id);
    if (!stage) return { success: false, message: 'Stage not found' };

    // A stage referenced by any piece — current status or past history — is
    // disabled rather than deleted, so historical records stay readable.
    //
    // Via count_pieces_in_stage() (migration 0019), not a direct
    // db.pieces.toArray() read: that read is subject to pieces_staff_all's
    // staff_can('pieces-admin') check (0014), which returns [] for a caller
    // without that permission — reached from Settings ('settings'
    // permission), not the Pieces page, so this must work regardless.
    // A blocked read silently computed 0 for both counts and always took the
    // hard-delete branch below, even when real pieces referenced the stage.
    // A failed or unavailable check refuses the delete rather than defaulting
    // to "0 pieces" — this function's whole purpose is to keep a hard delete
    // from running when it can't actually be verified safe, so an unreadable
    // count must not fall through to the delete branch below.
    const client = getDataClient();
    if (!client) {
      return { success: false, message: 'Could not verify whether pieces reference this stage. Please try again.' };
    }
    const { data, error } = await client.rpc('count_pieces_in_stage', { p_stage_name: stage.name });
    if (error) {
      console.error('count_pieces_in_stage failed:', error.message);
      return { success: false, message: 'Could not verify whether pieces reference this stage. Please try again.' };
    }
    const row = Array.isArray(data) ? data[0] : data;
    const piecesInStage = row?.current_count ?? 0;
    const piecesInHistory = row?.history_count ?? 0;

    if (piecesInStage > 0 || piecesInHistory > 0) {
      await db.pipelineStages.update(id, { enabled: false });
      return {
        success: true,
        deactivated: true,
        message: `"${stage.name}" is used by ${piecesInStage} current and ${piecesInHistory} historical piece(s), so it was disabled instead of deleted. Existing records keep this stage.`
      };
    }

    await db.pipelineStages.delete(id);
    return { success: true };
  };

  const reorderPipelineStages = async (newStages: PipelineStage[]) => {
    for (let i = 0; i < newStages.length; i++) {
      await db.pipelineStages.update(newStages[i].id, { order: i });
    }
  };



  /**
   * Guarantees the Admin Console is reachable.
   *
   * The main seed is skipped once the one-time data-wipe flag is set, so a
   * Backfills the phone match key on staff rows, so a record saved before the
   * field existed is still found by phone. No account is ever created here:
   * credentials belong to Supabase Auth.
   */
  const ensureStaffPhoneKeys = async () => {
    if (!supabase) return;
    try {
      const allStaff = await fetchTable<StaffMember>('staff');
      for (const member of allStaff) {
        const key = normalizeCustomerPhone(member.phone);
        if (key && member.normalizedPhone !== key) {
          await supabase.from('staff').update({ normalized_phone: key }).eq('id', member.id);
        }
      }
    } catch (err) {
      console.error('Failed to backfill staff sign-in keys:', err);
    }
  };

  useEffect(() => {
    ensureStaffPhoneKeys();
  }, []);


  /**
   * Guarantees the pottery pipeline configuration exists.
   *
   * The main seed is skipped once the one-time data-wipe flag is set, which left
   * Settings → Piece Pipeline Stages empty even though the Pottery Pieces page
   * was using these very statuses. This runs on every load: it creates the
   * stages if none exist and backfills the newer fields on older rows, without
   * touching a stage an admin has already customised.
   */
  // Pipeline stages are seeded by 0001_init.sql.



  /**
   * Ensures the Workshop option lists exist. Like the other configuration, the
   * main seed is skipped once the data-wipe flag is set, so this runs on every
   * load. Existing options are never overwritten — only missing lists are added
   * and older rows have `enabled` backfilled.
   */
  // Workshop option lists are seeded by 0001_init.sql.


  // ================= ADMIN CONSOLE SESSION =================
  const [currentStaffId, setCurrentStaffId] = useState<string | null>(null);
  const [staffAuthChecked, setStaffAuthChecked] = useState(false);
  /**
   * Guards against a stale resolveSessions() call overwriting a fresher
   * one. There are three independent triggers below (the mount-time
   * Promise.all check, staffSub, customerSub) that can each kick off a
   * resolveSessions() run; nothing about async ordering guarantees they
   * finish in the order they started. A login could set currentUser
   * correctly via customerSub, then a slower, already-in-flight
   * mount-time check — carrying a stale "not signed in yet" snapshot —
   * finishes afterward and wipes it back out. Bumped once per trigger,
   * captured by that trigger's own resolveSessions() call as its
   * "generation"; a write is only applied if its generation is still
   * the current one by the time it's about to happen.
   */
  const sessionGenerationRef = useRef(0);

  /**
   * Restores the Supabase session on load and re-derives who is signed in.
   *
   * Nothing about identity or role is read from local storage: the session
   * gives an auth id, and the staff/customer row is looked up from it, so a
   * revoked role or a deactivated account takes effect on the next load.
   */
  useEffect(() => {
    let cancelled = false;

    /** Who is signed in, re-derived from each session's auth id. */
    const resolveSessions = async (
      staffAuthId: string | null,
      customerAuthId: string | null,
      customerAuthEmail: string | null,
      generation: number
    ) => {
      if (cancelled) return;

      // The staff session decides which client data reads use, so set it
      // before reading anything.
      setStaffSessionActive(!!staffAuthId);

      if (staffAuthId) {
        const staffRows = await fetchTable<StaffMember>('staff');
        if (cancelled) return;
        // A newer trigger has already started since this one did — its
        // own resolution supersedes whatever this call is about to
        // write, so skip applying a now-stale result.
        if (generation === sessionGenerationRef.current) {
          const row = staffRows.find(m => m.userId === staffAuthId);
          setCurrentStaffId(row ? row.id : null);
          if (!row) setStaffSessionActive(false);
        }
      } else {
        if (generation === sessionGenerationRef.current) {
          setCurrentStaffId(null);
        }
      }

      if (customerAuthId) {
        // Right after sign-up, this fires from the same SIGNED_IN event that
        // triggers registerCustomer()'s own resolution, and can race ahead of
        // the resolve_customer_record RPC that links this auth id to a row.
        // Retrying briefly avoids overwriting a correct sign-in with a
        // premature null just because the link had not committed yet.
        let row: CustomerAccount | undefined;
        for (let attempt = 0; attempt < 4 && !cancelled; attempt++) {
          const customerRows = await fetchTable<CustomerAccount>('customers');
          if (cancelled) return;
          row = customerRows.find(c => c.userId === customerAuthId);
          if (row) break;
          if (attempt < 3) await new Promise(r => setTimeout(r, 400));
        }
        if (cancelled) return;

        // Still nothing after the commit-lag retries above: not a race, but
        // the deferred half of registerCustomer()'s/claimCustomerAccount()'s
        // walk-in claim. That original call ran before email confirmation
        // existed, when auth.uid() was not yet this user, so
        // resolve_customer_record() correctly refused to attach ownership
        // (see 0010_fix_customer_ownership_verification.sql / audit finding
        // C-1). Retry now that the session is real — the RPC only attaches
        // when auth.uid() matches AND the target record's own stored email
        // already equals this address, so this cannot attach somebody else's
        // record, only complete a legitimate one.
        // Phone accounts (VITE_PHONE_AUTH only): a session whose phone Supabase
        // has confirmed is linked by that verified phone instead — the
        // email-only heal below cannot match it, and would create a phoneless
        // "Guest" row. link_customer_by_verified_phone() (migration 0041) reads
        // the phone from the session itself; nothing is passed in.
        let linkedByPhone = false;
        if (!row && PHONE_AUTH_ENABLED && supabase) {
          const { data: sessionData } = await supabase.auth.getSession();
          const sessionUser = sessionData.session?.user;
          if (sessionUser?.id === customerAuthId && sessionUser.phone && sessionUser.phone_confirmed_at) {
            linkedByPhone = true;
            const { data: link, error: linkError } = await supabase.rpc('link_customer_by_verified_phone', { p_name: null });
            if (linkError) console.error('link_customer_by_verified_phone failed:', linkError.message);
            if (cancelled) return;
            const linkedId = (link as { customer_id?: string } | null)?.customer_id;
            if (linkedId) {
              const linkedRows = await fetchTable<CustomerAccount>('customers');
              if (cancelled) return;
              row = linkedRows.find(c => c.id === linkedId);
            }
          }
        }

        if (!row && !linkedByPhone && customerAuthEmail && supabase) {
          const { data: healedId, error: healError } = await supabase.rpc('resolve_customer_record', {
            p_name: null,
            p_phone: null,
            p_email: customerAuthEmail,
            p_auth_id: customerAuthId,
            p_source: 'Website Registration'
          });
          if (healError) console.error('resolve_customer_record heal failed:', healError.message);
          if (cancelled) return;
          if (healedId) {
            const healedRows = await fetchTable<CustomerAccount>('customers');
            if (cancelled) return;
            row = healedRows.find(c => c.id === healedId);
          }
        }

        if (generation === sessionGenerationRef.current) {
          setCurrentUser(row
            ? { id: row.id, name: row.name, email: row.email, phone: row.phone }
            : null);
        }
      } else {
        if (generation === sessionGenerationRef.current) {
          setCurrentUser(null);
        }
      }

      // Monotonic and idempotent — never needs to be undone, so it's
      // fine (and necessary) for this to run even from a superseded
      // generation: whichever call reaches this line first is enough to
      // clear the initial "checking your session…" state.
      setStaffAuthChecked(true);
    };

    if (!supabase || !supabaseStaff) {
      setStaffAuthChecked(true);
      return;
    }

    let staffId: string | null = null;
    let customerId: string | null = null;
    let customerEmail: string | null = null;

    // Captured synchronously, right here — not inside the .then() below.
    // getSession() reflects session state as of THIS moment (mount), so
    // its generation must be assigned now too, or a login that completes
    // before this promise happens to settle would be numbered LOWER than
    // this stale call once it finally resolves late, letting a
    // pre-login "not signed in" snapshot masquerade as the newest
    // generation simply by finishing last. staffSub/customerSub don't
    // have this problem: their callback fires synchronously exactly
    // when their data becomes current, so incrementing inline there
    // already captures the right moment.
    const mountGeneration = ++sessionGenerationRef.current;
    Promise.all([
      supabaseStaff.auth.getSession(),
      supabase.auth.getSession()
    ]).then(([staffSession, customerSession]) => {
      staffId = staffSession.data.session?.user?.id ?? null;
      customerId = customerSession.data.session?.user?.id ?? null;
      customerEmail = customerSession.data.session?.user?.email ?? null;
      if (PHONE_AUTH_ENABLED) setPhoneSetupPending(isPhoneSetupPending(customerSession.data.session?.user));
      // Seeds guard 2. Until this runs, hadCustomerSession is false, so a
      // SIGNED_OUT arriving during startup cannot announce an expiry.
      hadCustomerSessionRef.current = customerId !== null;
      resolveSessions(staffId, customerId, customerEmail, mountGeneration);
    });

    const staffSub = supabaseStaff.auth.onAuthStateChange((_e, session) => {
      staffId = session?.user?.id ?? null;
      sessionGenerationRef.current += 1;
      resolveSessions(staffId, customerId, customerEmail, sessionGenerationRef.current);
    });

    const customerSub = supabase.auth.onAuthStateChange((event, session) => {
      const nextCustomerId = session?.user?.id ?? null;

      if (event === 'SIGNED_OUT') {
        if (intentionalSignOutRef.current) {
          // They asked. Consume the flag and say nothing.
          intentionalSignOutRef.current = false;
        } else if (hadCustomerSessionRef.current) {
          setSessionExpired(true);
        }
      }
      // Signed in again, by any route — the notice has served its purpose.
      if (nextCustomerId) setSessionExpired(false);

      hadCustomerSessionRef.current = nextCustomerId !== null;
      customerId = nextCustomerId;
      customerEmail = session?.user?.email ?? null;
      if (PHONE_AUTH_ENABLED) setPhoneSetupPending(isPhoneSetupPending(session?.user));
      sessionGenerationRef.current += 1;
      resolveSessions(staffId, customerId, customerEmail, sessionGenerationRef.current);
    });

    return () => {
      cancelled = true;
      staffSub.data.subscription.unsubscribe();
      customerSub.data.subscription.unsubscribe();
    };
  }, []);

  /** Always re-read from the live staff table so role and permission edits apply. */
  const currentStaff = React.useMemo(
    () => (currentStaffId ? staff.find(s => s.id === currentStaffId) || null : null),
    [currentStaffId, staff]
  );

  // A staff member who loses console access is signed out immediately.
  useEffect(() => {
    if (currentStaffId && staff.length > 0 && !hasConsoleAccount(currentStaff)) {
      // Losing console access signs them out immediately.
      setCurrentStaffId(null);
      setStaffSessionActive(false);
      supabaseStaff?.auth.signOut();
    }
  }, [currentStaffId, currentStaff, staff]);

  // ---- Dashboard "Pottery Awaiting Pickup" widget (audit finding C-4) ----
  /**
   * Fed by get_overdue_pickup_pieces(), a narrow SECURITY DEFINER RPC gated
   * on is_staff() alone (not staff_can('pieces-admin')) — this widget must
   * keep working for any console-access staff member independent of that
   * specific permission, once pieces/piece_history RLS requires it (see the
   * C-4 chunk 2 migration, 0014 — not yet applied).
   *
   * Polled rather than Realtime-subscribed. Supabase Realtime's
   * postgres_changes respects RLS on the underlying table, so a staff
   * session without pieces-admin would silently receive zero change events
   * for `pieces` once 0014 lands — a Realtime subscription here would look
   * live for a Super Admin and quietly never update for exactly the staff
   * member this mechanism exists for. The RPC itself is unaffected (SECURITY
   * DEFINER bypasses RLS internally); only the "tell me when it changed"
   * signal is unreliable, so this refetches on an interval, plus explicitly
   * right after this session's own mark-collected/send-reminder calls
   * succeed, instead of waiting for the next tick.
   */
  const [overduePickupPieces, setOverduePickupPieces] = useState<PotteryPiece[]>([]);

  const fetchOverduePickupPieces = async () => {
    // Staff-only (see the useEffect below, gated on currentStaffId): must go
    // through the staff auth client, not the customer one. A staff session
    // with no simultaneous customer sign-in has no session at all on
    // `supabase`, so calling it directly here sent every request
    // unauthenticated — PostgREST treated it as anon, and 0015's own
    // `revoke ... from anon` correctly rejected it with a 401.
    const client = getDataClient();
    if (!client) return;
    const { data, error } = await client.rpc('get_overdue_pickup_pieces');
    if (error) {
      console.error('get_overdue_pickup_pieces failed:', error.message);
      return;
    }
    setOverduePickupPieces(rowsToModels<PotteryPiece>(data || []));
  };

  useEffect(() => {
    if (!currentStaffId) {
      setOverduePickupPieces([]);
      return;
    }
    fetchOverduePickupPieces();
    const interval = setInterval(fetchOverduePickupPieces, 45000);
    return () => clearInterval(interval);
  }, [currentStaffId]);

  /**
   * The Dashboard widget's "Mark Collected" — replaces a direct
   * updatePieceStatus()/updatePiece() call, which pieces/piece_history RLS
   * would refuse for a caller without pieces-admin once 0014 is applied.
   * mark_piece_collected() only performs the pieces/piece_history writes;
   * the customer/staff notifications below are unaffected by that gating
   * (notifications stays on blanket is_staff()) and are reproduced here
   * exactly as updatePieceStatus() already does for this transition. The
   * caller supplies the display fields it already has from
   * get_overdue_pickup_pieces()'s own result, since a fresh db.pieces.get()
   * would itself now be blocked for this same caller.
   */
  const markPieceCollected = async (piece: {
    id: string; name: string; pieceCode?: string; customerName: string; customerPhone: string;
  }) => {
    // Staff-only (see AdminDashboardSection.tsx, its only caller) — must go
    // through the staff auth client, not the customer one. Same reasoning
    // as fetchOverduePickupPieces() above.
    const client = getDataClient();
    if (!client) return { success: false, error: SUPABASE_NOT_CONFIGURED };

    const riyadhTime = `${getRiyadhDateString()} ${getRiyadhNow().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    const { data: ok, error } = await client.rpc('mark_piece_collected', {
      p_id: piece.id,
      // Riyadh-local, matching the original updatePiece(id, { collectionDate:
      // todayDateStr }) exactly — Postgres's own current_date would reflect
      // the database server's timezone (Supabase defaults to UTC), not
      // Riyadh's, which could record the wrong calendar day near midnight.
      p_collection_date: todayDateStr,
      p_riyadh_time: riyadhTime
    });

    if (error || !ok) {
      return { success: false, error: error?.message || 'This piece is no longer awaiting pickup.' };
    }

    await fetchOverduePickupPieces();

    // Notifications + SMS, via the same shared helper updatePieceStatus()
    // and addPiece() use (SMS integration, Chunk 6.5). Safe to call here:
    // the RLS constraint documented in this function's own doc comment
    // above — why it can't call updatePieceStatus() directly — is
    // specifically about the pieces/piece_history WRITE, which
    // mark_piece_collected() already performed server-side a moment ago,
    // bypassing RLS internally as a SECURITY DEFINER function.
    // notifyPieceStatusChange() never touches pieces or piece_history —
    // it only reads pipeline_stages/notifications and writes
    // notifications — so none of that constraint applies to it. Produces
    // byte-identical notification rows to what this function used to
    // build by hand (same title, message, highlighted, performedBy,
    // gating), plus now also SMS, matching Chunk 6's "Collected" wiring.
    await notifyPieceStatusChange(piece, 'Collected', 'Front Desk Admin', 'Customer collected piece in-store.');

    return { success: true };
  };

  /**
   * The Dashboard widget's "Send Reminder" — matches handleSendReminder()'s
   * existing behavior exactly: only last_notification_date changes, no
   * notification row (there never was one for this action).
   */
  const sendPickupReminder = async (piece: {
    id: string; name: string; pieceCode?: string; customerName: string; customerPhone: string;
  }): Promise<SendPickupReminderOutcome> => {
    // Staff-only (see AdminDashboardSection.tsx, its only caller) — must go
    // through the staff auth client, not the customer one. Same reasoning
    // as fetchOverduePickupPieces() above. (The send-sms call further down
    // already correctly used supabaseStaff — only this RPC call was wrong.)
    const client = getDataClient();
    if (!client) return { outcome: 'failed', error: SUPABASE_NOT_CONFIGURED };

    const { data: result, error } = await client.rpc('send_piece_pickup_reminder', {
      p_id: piece.id,
      // Riyadh-local, matching the original updatePiece(id, {
      // lastNotificationDate: todayDateStr }) exactly — same reasoning as
      // markPieceCollected()'s p_collection_date above. Also what 0016's
      // cooldown compares against, so "today" here and "today" in the
      // cooldown check can never disagree.
      p_reminder_date: todayDateStr
    });

    if (error || result === 'not_found') {
      return { outcome: 'failed', error: error?.message || 'This piece is no longer awaiting pickup.' };
    }

    if (result === 'cooldown') {
      // Nothing was written and no SMS was attempted — surfaced as its
      // own outcome, not a failure, so the UI doesn't tell staff
      // something went wrong when nothing did.
      return { outcome: 'cooldown' };
    }

    // result === 'sent': the database write already committed. Nothing
    // below can undo it — an SMS failure past this point only changes
    // smsSent, never the outcome kind, matching the "fire-and-forget,
    // don't block the primary action" posture from the design phase.
    await fetchOverduePickupPieces();

    if (!piece.customerPhone) {
      return { outcome: 'sent', smsSent: false, smsError: 'No phone number on file for this customer.' };
    }
    if (!supabaseStaff) {
      return { outcome: 'sent', smsSent: false, smsError: SUPABASE_NOT_CONFIGURED };
    }

    // English then Arabic, from pieceSmsTemplates.ts like every piece SMS.
    const message = bilingualSms(PICKUP_REMINDER_TEXT);

    try {
      const { data: smsData, error: smsError } = await supabaseStaff.functions.invoke('send-sms', {
        body: { phone: piece.customerPhone, message }
      });

      if (!smsError) {
        const response = smsData as { success: boolean; error?: string };
        return response.success
          ? { outcome: 'sent', smsSent: true }
          : { outcome: 'sent', smsSent: false, smsError: response.error || 'The SMS provider could not deliver this message.' };
      }

      if (smsError instanceof FunctionsHttpError) {
        try {
          const body = await smsError.context.json();
          const response = body as { success: boolean; error?: string };
          return { outcome: 'sent', smsSent: false, smsError: response.error || 'The SMS provider could not deliver this message.' };
        } catch {
          return { outcome: 'sent', smsSent: false, smsError: 'The server returned an unexpected response.' };
        }
      }

      // FunctionsRelayError / FunctionsFetchError / anything else the SDK
      // throws before a structured answer exists.
      return { outcome: 'sent', smsSent: false, smsError: smsError.message || 'Could not reach the SMS server. Check your connection and try again.' };
    } catch (err: any) {
      return { outcome: 'sent', smsSent: false, smsError: err?.message || 'Could not reach the SMS server. Check your connection and try again.' };
    }
  };

  /**
   * Signs a staff member in with an email address or a phone number in any
   * format. There is no default staff account: a failed match signs nobody in.
   */
  const loginStaff = async (emailOrPhone: string, password: string) => {
    const input = String(emailOrPhone || '').trim();
    if (!input) return { success: false, error: 'Enter your email address or phone number.' };
    if (!password) return { success: false, error: 'Enter your password.' };
    if (!supabaseStaff) return { success: false, error: SUPABASE_NOT_CONFIGURED };

    const email = canonicalEmail(input);
    if (!email.includes('@')) {
      // Console sign-in is by email; the phone field stays for the customer site.
      return { success: false, error: 'Sign in with your work email address.' };
    }

    // 1. Supabase Auth verifies the credential, on the console's own session
    //    so signing in as a customer elsewhere does not sign staff out.
    const { data, error } = await supabaseStaff.auth.signInWithPassword({ email, password });
    if (error || !data.user) {
      // The real reason, so "email not confirmed" is not reported as a wrong
      // password.
      return { success: false, error: friendlyAuthError(error?.message || '') };
    }

    // 2. The staff record, resolved from the auth id ONLY (audit finding
    //    C-3). Role and permissions are read from this row — never from the
    //    token or anything stored locally. Read fresh, not from the cached
    //    list: a role or access change made a moment ago must apply to this
    //    sign-in.
    //
    //    There is deliberately no email-match fallback here anymore. That
    //    fallback used to let anyone who could authenticate as ANY Supabase
    //    Auth identity sharing a staff member's email get bound to that
    //    staff row on whichever login happened to reach it first — the
    //    account merely needed to exist and the addresses to match, nothing
    //    about actually being that person. staff.user_id is now established
    //    exclusively by the provision-staff Edge Function, under a
    //    server-verified Super Admin check; login only ever reads that
    //    relationship, never creates or repoints it.
    const all = await fetchTable<StaffMember>('staff');
    const account = all.find(member => member.userId === data.user!.id);

    if (!account) {
      await supabaseStaff.auth.signOut();
      // staff_read's RLS policy (is_staff()) gates the entire table on the
      // exact same condition this lookup is testing — user_id = auth.uid(),
      // console access on, status active — so if that policy let any rows
      // through at all, this caller's own row is guaranteed to be among
      // them and guaranteed to match. Reaching this branch always means the
      // caller isn't currently a recognized, console-enabled staff member;
      // there is no other distinguishable case to report. Safe to be this
      // specific because signInWithPassword already succeeded — this
      // message only ever reaches someone who has already proven a real
      // credential, not an anonymous prober.
      return {
        success: false,
        error: 'This account is not recognized by the Admin Console. If you were recently provisioned, ask a Super Admin to confirm your console access is enabled.'
      };
    }

    // 3. The existing console guards, unchanged.
    if (!account.hasConsoleAccess) {
      await supabaseStaff.auth.signOut();
      return { success: false, error: 'This staff profile does not have Admin Console access.' };
    }
    if (account.status === 'Inactive' || account.status === 'Former Staff') {
      await supabaseStaff.auth.signOut();
      return { success: false, error: `This account is ${account.status} and cannot sign in.` };
    }

    // Data reads now go through the staff session, so RLS grants the
    // staff-only tables.
    setStaffSessionActive(true);
    setCurrentStaffId(account.id);
    // user_id is never written here (audit finding C-3) — it was already
    // required to equal data.user.id for account to have been found above,
    // and login only ever reads that relationship, never establishes it.
    await db.staff.update(account.id, {
      lastLoginAt: new Date().toISOString()
    });

    return { success: true, mustChangePassword: account.passwordIsTemporary === true };
  };

  /**
   * Replaces the signed-in staff member's password through Supabase Auth and
   * clears the temporary flag, so the console stops asking.
   */
  const changeStaffPassword = async (newPassword: string) => {
    if (!supabaseStaff) return { success: false, error: SUPABASE_NOT_CONFIGURED };

    const strength = validatePasswordRule(newPassword);
    if (!strength.valid) return { success: false, error: strength.error };

    try {
      // A hung request must not leave the screen stuck on "Saving...".
      const update = supabaseStaff!.auth.updateUser({ password: newPassword });
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('The authentication service did not respond. Check your connection and try again.')), 15000)
      );
      const { error } = await Promise.race([update, timeout]) as { error: any };

      if (error) return { success: false, error: friendlyAuthError(error.message) };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Could not save the new password.' };
    }

    if (currentStaffId) {
      await db.staff.update(currentStaffId, { passwordIsTemporary: false });
      // The flag was set in Postgres by the provisioning script, so clear it
      // there too — otherwise the next sign-in asks again. Not fatal if it
      // fails: Dexie is authoritative until Stage 2.
      try {
        await supabase.from('staff').update({ password_is_temporary: false }).eq('id', currentStaffId);
      } catch (err) {
        console.warn('Could not clear password_is_temporary in Supabase:', err);
      }
    }

    return { success: true };
  };

  const logoutStaff = async () => {
    if (supabaseStaff) await supabaseStaff.auth.signOut();
    setStaffSessionActive(false);
    setCurrentStaffId(null);
    // Signing out always drops back to the public site.
    setArea('customer');
  };

  const goToStaffLogin = () => {
    if (STAFF_SITE_URL) { window.location.href = STAFF_SITE_URL; return; }
    setArea('staff');
  };
  const viewCustomerSite = () => {
    if (CUSTOMER_SITE_URL) { window.location.href = CUSTOMER_SITE_URL; return; }
    setArea('customer');
  };
  /**
   * Only meaningful for an authenticated staff member. Once the sites are
   * split, a staff session's storage lives on the staff origin, so
   * currentStaffId is never populated while landing on the customer
   * origin from a fresh cross-domain navigation — this stays dead code
   * in that case, which is correct: there's no session to jump back into
   * without visiting the staff site's own login again.
   */
  const returnToStaffConsole = () => {
    if (!currentStaffId) return;
    if (STAFF_SITE_URL) { window.location.href = STAFF_SITE_URL; return; }
    setArea('staff');
  };

  const canAccessAdminPage = (pageId: string) => canAccessPage(currentStaff, pageId);

  // ================= UNIFIED CUSTOMER IDENTITY =================
  /**
   * The single find-or-create used by every surface that captures a customer:
   * the queue, bookings, the pottery console and admin creation. Matching is by
   * normalized phone first, so the same person is never stored twice.
   */
  /**
   * `source` records HOW THIS CUSTOMER FIRST REACHED THE STUDIO, so it is only
   * ever written when the record is created. resolve_customer_record's update
   * branch does not touch the column, so passing it can never re-tag an existing
   * customer, and it plays no part in matching — that is phone, then email.
   *
   * Every caller used to leave it null, and the function defaults a null to
   * 'Website'. So a walk-in checked in at the counter was filed as having come
   * from the website, and the field carried no information at all.
   *
   * Values come from CustomerAccount['source'], not Booking['source'] — they are
   * different vocabularies for different questions. A booking's source is how
   * that booking was taken; a customer's is where the relationship started.
   */
  const resolveCustomer = async (
    input: { name?: string; phone?: string; email?: string },
    source?: CustomerAccount['source']
  ) => {
    // Find-or-create runs in Postgres. It has to: a guest booking is made by an
    // anonymous visitor, who cannot read or insert customer rows directly, and
    // doing the lookup client-side would also race two simultaneous walk-ins
    // into two records for the same person.
    const known = await db.customers.toArray();
    const { customer: cached, reason } = findCustomerMatch(known, {
      phone: input.phone,
      email: input.email
    });

    if (!supabase) {
      return { customer: (cached || { id: '', name: input.name || 'Guest' }) as CustomerAccount, created: false, matchedOn: reason };
    }

    // Nothing to match on: the RPC would only create an empty 'Guest' row
    // (0042 makes it return null instead). Same result as a failed call.
    if (!String(input.phone ?? '').trim() && !String(input.email ?? '').trim()) {
      return { customer: (cached || { id: '', name: input.name || 'Guest' }) as CustomerAccount, created: false, matchedOn: reason };
    }

    const { data: id, error } = await supabase.rpc('resolve_customer_record', {
      p_name: input.name ?? null,
      p_phone: input.phone ?? null,
      p_email: input.email ?? null,
      p_auth_id: null,
      p_source: source ?? null
    });

    if (error || !id) {
      console.error('resolve_customer_record failed:', error?.message);
      return { customer: (cached || { id: '', name: input.name || 'Guest' }) as CustomerAccount, created: false, matchedOn: reason };
    }

    // resolve_customer_record() already returned the id — the caller's own
    // input is the rest of what any of this function's callers ever read
    // (only .id is actually used downstream). There is no need to read the
    // row back through get_customer_summary(), which had no ownership check
    // and let an anonymous caller harvest another customer's PII by guessing
    // an id (audit finding C-2).
    const customer = { ...buildCustomerIdentity(input), id } as CustomerAccount;

    return { customer, created: !cached, matchedOn: cached ? reason : 'none' };
  };

  /**
   * Backfills match keys and consolidates records that share a phone number.
   * History is never deleted: relationships are re-pointed at the canonical
   * record and the duplicate is removed only once nothing references it.
   */
  /**
   * Moves every piece from one customer id to another, regardless of the
   * caller's pieces-admin permission — via reassign_customer_pieces()
   * (migration 0018). The consolidation effect below runs unattended for any
   * staff session that can see duplicate customers; a direct db.pieces write
   * would be silently dropped by pieces_staff_all's staff_can('pieces-admin')
   * check (0014) for a session without that permission, and the duplicate
   * customer would then be deleted anyway — Postgres's `on delete set null`
   * would sever those pieces from their customer permanently. See migration
   * 0018 for the full trace.
   */
  const reassignCustomerPieces = async (oldCustomerId: string, newCustomerId: string): Promise<number> => {
    const client = getDataClient();
    if (!client) return 0;
    const { data, error } = await client.rpc('reassign_customer_pieces', {
      p_old_customer_id: oldCustomerId,
      p_new_customer_id: newCustomerId
    });
    if (error) {
      console.error('reassign_customer_pieces failed:', error.message);
      return 0;
    }
    return data ?? 0;
  };

  /**
   * A customer's piece count, regardless of the caller's pieces-admin
   * permission — via count_pieces_for_customer() (migration 0020). The
   * global `pieces` context value is empty for a caller without that
   * permission (0014), so a direct filter over it — as
   * summarizeCustomerActivity() used to do for Live Queue's customer-detail
   * panel — silently undercounted. Not currently rendered anywhere the
   * result would be visible, but the value was wrong regardless.
   */
  const getCustomerPieceCount = async (customerId?: string, phone?: string): Promise<number> => {
    const client = getDataClient();
    if (!client) return 0;
    const { data, error } = await client.rpc('count_pieces_for_customer', {
      p_customer_id: customerId ?? null,
      p_customer_phone: phone ?? null
    });
    if (error) {
      console.error('count_pieces_for_customer failed:', error.message);
      return 0;
    }
    return data ?? 0;
  };

  useEffect(() => {
    const consolidate = async () => {
      try {
        const all = await db.customers.toArray();
        if (all.length === 0) return;

        // 1. Backfill the normalized key on older records.
        for (const customer of all) {
          if (!customer.normalizedPhone && customer.phone) {
            await db.customers.update(customer.id, {
              normalizedPhone: normalizeCustomerPhone(customer.phone),
              displayPhone: customer.displayPhone || toDisplayPhone(customer.phone)
            });
          }
        }

        // 2. Consolidate duplicates that share a normalized phone.
        const groups = findDuplicateGroups(await db.customers.toArray());
        for (const group of groups) {
          for (const duplicate of group.duplicates) {
            const canonicalId = group.canonical.id;

            const [bookingRows, queueRows] = await Promise.all([
              db.bookings.toArray(),
              db.queue.toArray()
            ]);

            await Promise.all([
              ...bookingRows
                .filter(b => b.customerId === duplicate.id)
                .map(b => db.bookings.update(b.id, { customerId: canonicalId })),
              ...queueRows
                .filter(q => q.customerId === duplicate.id)
                .map(q => db.queue.update(q.id, { customerId: canonicalId })),
              // Via reassign_customer_pieces() (0018), not a direct db.pieces
              // read/write — see that migration for why the direct form
              // silently dropped this step for a caller without pieces-admin.
              reassignCustomerPieces(duplicate.id, canonicalId)
            ]);

            // Keep any detail the duplicate had that the canonical record lacks.
            const fill: Partial<CustomerAccount> = {};
            if (!group.canonical.email && duplicate.email) fill.email = duplicate.email;
            if (!group.canonical.notes && duplicate.notes) fill.notes = duplicate.notes;
            if (Object.keys(fill).length > 0) await db.customers.update(canonicalId, fill);

            await db.customers.delete(duplicate.id);
          }
        }
      } catch (err) {
        console.error('Customer consolidation failed:', err);
      }
    };

    consolidate();
  }, []);

  // ---- Customer mutators ----
  /**
   * Creates a customer record from the Staff Console. These are guest records:
   * no authentication link is created, so they stay Walk-In / Guest until an
   * account is linked to them.
   */
  const addCustomer = async (customer: Omit<CustomerAccount, 'id' | 'createdAt'>) => {
    // Shared rules, enforced at the write itself so no caller can bypass them.
    const nameCheck = validateRequired(customer.name, 'Customer name');
    if (!nameCheck.valid) return { success: false, error: nameCheck.error };

    const phoneCheck = validatePhoneRule(customer.phone);
    if (!phoneCheck.valid) return { success: false, error: phoneCheck.error };

    const emailCheck = validateEmailRule(customer.email, false);
    if (!emailCheck.valid) return { success: false, error: emailCheck.error };

    const canonical = customerStorageFields({ phone: customer.phone, email: customer.email });

    // Reuse an existing record rather than creating a duplicate. Matched on the
    // normalized key so any stored format is recognised.
    const allCustomers = await db.customers.toArray();
    const existing = allCustomers.find(c => customerPhoneKey(c) === canonical.normalizedPhone);
    if (existing) {
      return {
        success: false,
        error: `This number already has an account under ${existing.name || 'another customer'}.`,
        customerId: existing.id
      };
    }

    // Was `CUST-${Math.floor(1000 + Math.random() * 9000)}` — only 9,000
    // possible values, and .put() below was an upsert: a collision would have
    // silently merged this customer's data into whichever existing record
    // already held that id. A uuid makes the collision itself negligible;
    // .add() (a real insert that throws on conflict, unlike .put()) is the
    // second half of the fix, matching how queue.id was hardened in 0030.
    const id = `CUST-${globalThis.crypto?.randomUUID?.() ?? `cust-${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
    await db.customers.add({
      ...customer,
      id,
      name: customer.name.trim(),
      ...canonical,
      // Explicitly not an account: no userId, no credential.
      hasAccount: false,
      createdAt: new Date().toISOString()
    });

    return { success: true, customerId: id };
  };

  const updateCustomer = async (id: string, updates: Partial<CustomerAccount>) => {
    const identity = (updates.phone !== undefined || updates.email !== undefined)
      ? customerStorageFields({
          phone: updates.phone ?? (await db.customers.get(id))?.phone,
          email: updates.email ?? (await db.customers.get(id))?.email
        })
      : {};
    try {
      await db.customers.update(id, { ...updates, ...identity, updatedAt: new Date().toISOString() });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to update customer details.' };
    }
  };

  // Staff Mutators
  const addStaffMember = async (member: Omit<StaffMember, 'id'>) => {
    const id = `staff-${Date.now()}`;
    await db.staff.add({
      ...member,
      // Canonical phone/email, so duplicate checks and login matching agree.
      ...staffStorageFields({ phone: member.phone, email: member.email }),
      id,
      // New staff start with no working hours; the admin adds them manually.
      weeklySchedule: member.weeklySchedule || {},
      createdAt: member.createdAt || new Date().toISOString()
    });
  };

  const updateStaffMember = async (id: string, updates: Partial<StaffMember>) => {
    // Only re-canonicalise the identity fields when they are actually part of
    // this update, so a schedule-only save leaves them untouched.
    const identity = (updates.phone !== undefined || updates.email !== undefined)
      ? staffStorageFields({ phone: updates.phone, email: updates.email })
      : {};
    await db.staff.update(id, { ...updates, ...identity, updatedAt: new Date().toISOString() });
  };

  const deleteStaffMember = async (id: string) => {
    const member = await db.staff.get(id);
    if (!member) return { success: false, message: 'Staff member not found' };

    // Match by staff ID, falling back to the name for legacy rows saved without one.
    const workshopsAssigned = await db.workshops
      .filter(w => w.staffId === id || (!w.staffId && w.instructor === member.name))
      .toArray();

    // Via count_pieces_assigned_to_staff() (migration 0019), not a direct
    // db.pieces read: that read is subject to pieces_staff_all's
    // staff_can('pieces-admin') check (0014), which returns [] for a caller
    // without that permission — reached from Staff Management ('staff'
    // permission), not the Pieces page, so this must work regardless. A
    // failed or unavailable check refuses the delete rather than defaulting
    // to "0 pieces assigned", since that default would silently let a staff
    // member with real piece assignments be deleted.
    const client = getDataClient();
    if (!client) {
      return { success: false, message: 'Could not verify whether pieces are assigned to this staff member. Please try again.' };
    }
    const { data: piecesAssignedCount, error } = await client.rpc('count_pieces_assigned_to_staff', { p_staff_name: member.name });
    if (error) {
      console.error('count_pieces_assigned_to_staff failed:', error.message);
      return { success: false, message: 'Could not verify whether pieces are assigned to this staff member. Please try again.' };
    }

    const totalWorkshops = workshopsAssigned.length;
    const totalPieces = piecesAssignedCount ?? 0;

    if (totalWorkshops > 0 || totalPieces > 0) {
      return {
        success: false,
        message: `Cannot delete staff member "${member.name}" because they are currently assigned to ${totalWorkshops} workshop(s) and ${totalPieces} pottery piece(s). Please reassign their work first.`,
        assignmentsCount: totalWorkshops + totalPieces
      };
    }

    await db.staff.delete(id);
    return { success: true };
  };

  /**
   * Calls provision-staff to establish staff.user_id (audit finding C-3).
   * Uses the staff client, not the customer one — only an authenticated
   * console session can reach this, and the function itself re-verifies the
   * caller is an active Super Admin server-side regardless.
   *
   * `kind: 'network_error'` means the request never got a structured answer
   * (offline, DNS, the relay couldn't reach the function, an unparseable
   * response) — distinct from `kind: 'response'`, where the function DID run
   * and answered, successfully or not. A non-2xx status from the function
   * (FunctionsHttpError) still carries its JSON body in `error.context` —
   * that's the function's own structured rejection (collision, duplicate
   * email, forbidden, ...), not a failure to reach it, so it's parsed and
   * returned as a normal 'response', the same as a 200.
   */
  const provisionStaff = async (staffId: string): Promise<ProvisionStaffOutcome> => {
    if (!supabaseStaff) {
      return { kind: 'network_error', message: SUPABASE_NOT_CONFIGURED };
    }

    try {
      const { data, error } = await supabaseStaff.functions.invoke('provision-staff', {
        body: { staffId }
      });

      if (!error) {
        return { kind: 'response', response: data as ProvisionStaffResponse };
      }

      if (error instanceof FunctionsHttpError) {
        try {
          const body = await error.context.json();
          return { kind: 'response', response: body as ProvisionStaffResponse };
        } catch {
          return { kind: 'network_error', message: 'The server returned an unexpected response. Please try again.' };
        }
      }

      // FunctionsRelayError / FunctionsFetchError / anything else the SDK
      // throws before a structured answer exists.
      return {
        kind: 'network_error',
        message: error.message || 'Could not reach the server. Check your connection and try again.'
      };
    } catch (err: any) {
      return {
        kind: 'network_error',
        message: err?.message || 'Could not reach the server. Check your connection and try again.'
      };
    }
  };

  // Workshop Option Mutators
  const addWorkshopOption = async (option: Omit<WorkshopOption, 'id' | 'order'>) => {
    const all = await db.workshopOptions.where('type').equals(option.type).toArray();
    const order = all.length > 0 ? Math.max(...all.map(o => o.order)) + 1 : 0;
    const id = `wopt-${Date.now()}`;
    await db.workshopOptions.add({ ...option, id, order });
  };

  const updateWorkshopOption = async (id: string, value: string) => {
    await db.workshopOptions.update(id, { value });
  };

  const deleteWorkshopOption = async (id: string) => {
    const opt = await db.workshopOptions.get(id);
    if (!opt) return { success: false, message: 'Option not found' };

    // Check if in use
    let inUse = false;
    if (opt.type === 'skillLevel') {
      const count = await db.workshops.filter(w => w.skillLevel === opt.value).count();
      if (count > 0) inUse = true;
    } else if (opt.type === 'category') {
      const count = await db.workshops.filter(w => w.category === opt.value).count();
      if (count > 0) inUse = true;
    } else if (opt.type === 'room') {
      const count = await db.workshops.filter(w => w.room === opt.value).count();
      if (count > 0) inUse = true;
    } else if (opt.type === 'material') {
      const count = await db.workshops.filter(w => w.materials.includes(opt.value)).count();
      if (count > 0) inUse = true;
    }

    if (inUse) {
      return {
        success: false,
        message: `Cannot remove "${opt.value}" because it is currently in use by one or more workshops. Please edit those workshops to remove or change this option first.`
      };
    }

    await db.workshopOptions.delete(id);
    return { success: true };
  };

  const reorderWorkshopOptions = async (type: WorkshopOption['type'], newOptions: WorkshopOption[]) => {
    for (let i = 0; i < newOptions.length; i++) {
      await db.workshopOptions.update(newOptions[i].id, { order: i });
    }
  };

  // Event Option Mutators
  const addEventOption = async (option: Omit<EventOption, 'id' | 'order'>) => {
    const all = await db.eventOptions.where('type').equals(option.type).toArray();
    const order = all.length > 0 ? Math.max(...all.map(o => o.order)) + 1 : 0;
    const id = `eopt-${Date.now()}`;
    await db.eventOptions.add({ ...option, id, order });
  };

  const updateEventOption = async (id: string, value: string) => {
    await db.eventOptions.update(id, { value });
  };

  const deleteEventOption = async (id: string) => {
    const opt = await db.eventOptions.get(id);
    if (!opt) return { success: false, message: 'Option not found' };

    await db.eventOptions.delete(id);
    return { success: true };
  };

  const reorderEventOptions = async (type: EventOption['type'], newOptions: EventOption[]) => {
    for (let i = 0; i < newOptions.length; i++) {
      await db.eventOptions.update(newOptions[i].id, { order: i });
    }
  };

  const updateSetting = async (id: string, value: any) => {
    await db.appSettings.put({ id, value });
  };

  /**
   * Settings -> Data Reset.
   *
   * This now clears the SHARED database, not one browser's copy: every device
   * sees the result. Two things are deliberately preserved.
   *
   *  - staff, because deleting those rows would remove the signed-in Super
   *    Admin's own record and permanently lock the console (the auth user
   *    would survive with nothing to link to).
   *  - the configuration seeded by the migrations — stages, option lists,
   *    packages, resources, settings — which is no longer re-created by the
   *    client and could not be recovered without re-running the migration.
   */
  const removeAllData = async () => {
    localStorage.removeItem('artycafe_current_user');
    localStorage.removeItem('artycafe_pending_booking');

    // Operational records only, children before parents.
    await db.pieceHistory.clear();
    await db.notifications.clear();
    await db.queue.clear();
    await db.pieces.clear();
    await db.bookings.clear();
    await db.workshopSessions.clear();
    await db.workshops.clear();
    await db.events.clear();
    await db.customers.clear();

    setCurrentUser(null);
  };

  /**
   * Sample data is no longer generated by the app: the database is seeded by
   * supabase/migrations. Kept so the Settings button keeps its contract.
   */
  const reseedSampleData = async () => {
    console.info(
      'Sample data is seeded by supabase/migrations, not by the app. ' +
      'Re-run the migration to restore configuration rows.'
    );
    window.location.reload();
  };

  const loggingFieldsSetting = appSettings.find(s => s.id === 'potteryLoggingConsoleFields')?.value;
  const loggingFields: LoggingConsoleField[] = React.useMemo(() => {
    if (Array.isArray(loggingFieldsSetting) && loggingFieldsSetting.length > 0) {
      return [...loggingFieldsSetting].sort((a, b) => (a.order || 0) - (b.order || 0));
    }
    return DEFAULT_LOGGING_FIELDS;
  }, [loggingFieldsSetting]);

  const updateLoggingFields = async (fields: LoggingConsoleField[]) => {
    const sorted = [...fields].map((f, idx) => ({ ...f, order: idx + 1, updatedAt: new Date().toISOString() }));
    await updateSetting('potteryLoggingConsoleFields', sorted);
  };

  // ---- Studio rooms and table stations ----
  const addStudioResource = async (resource: Omit<StudioResource, 'id'>) => {
    const id = `res-${Date.now()}`;
    await db.studioResources.add({
      ...resource,
      id,
      order: resource.order ?? studioResources.length,
      createdAt: new Date().toISOString()
    });
  };

  const updateStudioResource = async (id: string, updates: Partial<StudioResource>) => {
    await db.studioResources.update(id, { ...updates, updatedAt: new Date().toISOString() });
  };

  /**
   * Resources referenced by a saved session, event or workshop are deactivated
   * rather than deleted, so historical assignments stay readable.
   */
  const removeStudioResource = async (id: string) => {
    const resource = await db.studioResources.get(id);
    if (!resource) return { success: false, message: 'Resource not found' };

    const [sessions, events, workshops] = await Promise.all([
      db.workshopSessions.toArray(),
      db.events.toArray(),
      db.workshops.toArray()
    ]);

    const usedBySession = sessions.some(x => x.roomId === id || x.tableId === id);
    const usedByEvent = events.some(x => x.roomId === id || x.tableId === id);
    const usedByWorkshop = workshops.some(x => x.roomId === id || x.tableId === id);

    if (usedBySession || usedByEvent || usedByWorkshop) {
      await db.studioResources.update(id, { status: 'Inactive', updatedAt: new Date().toISOString() });
      return {
        success: true,
        deactivated: true,
        message: `"${resource.name}" is used by existing sessions, so it was set to Inactive instead of being deleted.`
      };
    }

    await db.studioResources.delete(id);
    return { success: true, deactivated: false };
  };

  // ---- Birthday packages (shared between Staff Console and customer site) ----
  const publishedBirthdayPackages = React.useMemo(
    () => birthdayPackages
      .filter(p => p.status === 'Published')
      .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0)),
    [birthdayPackages]
  );

  const addBirthdayPackage = async (pkg: Omit<BirthdayPackage, 'id'>) => {
    const id = `bpkg-${Date.now()}`;
    await db.birthdayPackages.add({
      ...pkg,
      id,
      displayOrder: pkg.displayOrder ?? birthdayPackages.length,
      createdAt: new Date().toISOString()
    });
  };

  const updateBirthdayPackage = async (id: string, updates: Partial<BirthdayPackage>) => {
    await db.birthdayPackages.update(id, { ...updates, updatedAt: new Date().toISOString() });
  };

  const deleteBirthdayPackage = async (id: string) => {
    await db.birthdayPackages.delete(id);
  };

  const reorderBirthdayPackages = async (ordered: BirthdayPackage[]) => {
    for (let i = 0; i < ordered.length; i++) {
      await db.birthdayPackages.update(ordered[i].id, { displayOrder: i });
    }
  };

  // ---- Birthday booking-form fields (Settings → Events/Birthday only) ----
  const birthdayFieldsSetting = appSettings.find(s => s.id === 'birthdayFormFields')?.value;
  const birthdayFormFields: BirthdayFormField[] = React.useMemo(() => {
    if (Array.isArray(birthdayFieldsSetting) && birthdayFieldsSetting.length > 0) {
      return [...birthdayFieldsSetting].sort((a, b) => (a.order || 0) - (b.order || 0));
    }
    return DEFAULT_BIRTHDAY_FORM_FIELDS;
  }, [birthdayFieldsSetting]);

  // ---- Workshop card field configuration ----
  const workshopFieldsSetting = appSettings.find(s => s.id === 'workshopFieldConfig')?.value;
  const workshopFields: WorkshopFieldConfig[] = React.useMemo(() => {
    if (Array.isArray(workshopFieldsSetting) && workshopFieldsSetting.length > 0) {
      // Any core field missing from a stored configuration is restored, so the
      // Workshop form can never lose a field the data model depends on.
      const stored: WorkshopFieldConfig[] = [...workshopFieldsSetting];
      const keys = new Set(stored.map(f => f.fieldKey));
      const missing = DEFAULT_WORKSHOP_FIELDS.filter(f => !keys.has(f.fieldKey));
      return [...stored, ...missing];
    }
    return DEFAULT_WORKSHOP_FIELDS;
  }, [workshopFieldsSetting]);

  const updateWorkshopFields = async (fields: WorkshopFieldConfig[]) => {
    const stamped = fields.map(f => ({ ...f, updatedAt: new Date().toISOString() }));
    await updateSetting('workshopFieldConfig', stamped);
  };

  const updateBirthdayFormFields = async (fields: BirthdayFormField[]) => {
    const sorted = [...fields].map((f, idx) => ({ ...f, order: idx }));
    await updateSetting('birthdayFormFields', sorted);
  };

  // Determine if overall health check is passing
  useEffect(() => {
    const hasFailures = systemTests.some(t => t.status === 'failed');
    setTestsPassing(!hasFailures);
  }, [systemTests]);

  return (
    <AppContext.Provider value={{
      area, goToStaffLogin, viewCustomerSite, returnToStaffConsole,
      customerTab, setCustomerTab,
      adminTab, setAdminTab,
      pendingBooking, setPendingBooking,
      selectedBirthdayPackage, setSelectedBirthdayPackage,
      workshopsInitialCategory, setWorkshopsInitialCategory,
      currentUser, setCurrentUser,
      authScreen, setAuthScreen,
      registerCustomer, loginCustomer, claimCustomerAccount, changeCustomerPassword,
      requestPasswordReset, completePasswordReset, hasRecoverySession, recoveryLinkError,
      resetCustomerPassword, logoutCustomer,
      selectedWorkshopId, setSelectedWorkshopId,
      lastBookingCreated, setLastBookingCreated,
      editingWorkshopId, setEditingWorkshopId,
      selectedEventBookingId, setSelectedEventBookingId,
      settingsSection, setSettingsSection,
      todayDateStr, formattedTodayDate,
      getRelativeRiyadhDateStr, getRiyadhFormattedDate,
      workshops, bookings, queue, pieces, systemTests, notifications, events, workshopSessions,
      pipelineStages, staff, workshopOptions, eventOptions, categories, appSettings,
      rawWorkshops, rawEvents,
      loggingFields, updateLoggingFields,
      customers,
      currentStaff, staffAuthChecked, loginStaff, changeStaffPassword, logoutStaff, canAccessAdminPage,
      resolveCustomer,
      studioResources, addStudioResource, updateStudioResource, removeStudioResource,
      birthdayPackages, publishedBirthdayPackages,
      addBirthdayPackage, updateBirthdayPackage, deleteBirthdayPackage, reorderBirthdayPackages,
      workshopFields, updateWorkshopFields,
      birthdayFormFields, updateBirthdayFormFields,
      addWorkshop, updateWorkshop,
      sessionExpired, clearSessionExpired: () => setSessionExpired(false),
      phoneSetupPending,
      addBooking, bookingError, clearBookingError: () => setBookingError(null),
      cancelBooking, cancelOwnBooking, updateBookingStatus,
      addCategoryIfMissing, updateCategoryNameAr, assignBookingStaff, updateWorkshopSession, appendBookingTimeline,
      getFreshAssignmentSources, getFreshStaff, getCustomerPieceCount,
      addQueueItem, addStaffNotification, updateQueueStatus, updateQueueItem, reorderQueue, returnQueueItemToWaiting,
      assignQueueTables, seatQueueItem, changeQueueItemTables,
      updatePieceStatus, addPiece, updatePiece, markNotificationAsRead, clearAllNotifications,
      overduePickupPieces, markPieceCollected, sendPickupReminder,
      runAllTests, toggleTestResult,
      isTestRunning, testProgress, testsPassing,
      addEvent, updateEvent, deleteEvent,
      addPipelineStage, updatePipelineStage, deletePipelineStage, reorderPipelineStages,
      addCustomer, updateCustomer,
      addStaffMember, updateStaffMember, deleteStaffMember, provisionStaff,
      addWorkshopOption, updateWorkshopOption, deleteWorkshopOption, reorderWorkshopOptions,
      addEventOption, updateEventOption, deleteEventOption, reorderEventOptions,
      updateSetting, removeAllData, reseedSampleData
    }}>
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};
