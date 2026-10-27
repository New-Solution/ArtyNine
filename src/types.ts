/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface WorkshopSessionRecord {
  id: string; // e.g. "sess-10293"
  workshopId: string;
  date: string; // YYYY-MM-DD
  startTime: string; // e.g. "11:00 AM" or "16:00"
  endTime?: string;
  duration?: string;
  instructor?: string;
  staffId?: string;
  /** Studio space this session occupies. Ids are stable; the labels are for display. */
  roomId?: string;
  room?: string;
  tableId?: string;
  tableName?: string;
  /** Id of the recurring rule that generated this session, when it was generated. */
  ruleId?: string;
  capacity: number;
  status: 'Published' | 'Cancelled' | 'Unavailable' | 'Unpublished';
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkshopSession {
  id: number | string;
  date: string;
  time: string;
  capacity: number;
  /**
   * Seats left are counted from the bookings (getSessionSeatUsage on the staff
   * side, session_seats_summary on the customer side), never stored. There is
   * no such column on workshop_sessions and there never was.
   */
  isFull: boolean;
  status?: 'Published' | 'Cancelled' | 'Unavailable' | 'Unpublished';
  instructor?: string;
  staffId?: string;
}

export interface Category {
  id: string;
  name: string;
  /** Optional Arabic display name. Never a key or a matched value: `name` is. NULL means show the English. */
  nameAr?: string | null;
}

export interface RecurringScheduleRule {
  id: string;
  daysOfWeek: string[]; // e.g. ['Sunday', 'Tuesday']
  startTime: string; // e.g. "04:00 PM"
  endTime?: string; // e.g. "06:00 PM"
  duration?: string; // e.g. "2 hours"
  instructor: string;
  staffId?: string;
  capacity: number;
  room?: string;
  roomId?: string;
  tableId?: string;
  effectiveStartDate: string; // YYYY-MM-DD
  effectiveEndDate?: string; // YYYY-MM-DD
  status: 'Active' | 'Inactive';
}

export interface SessionException {
  id: string;
  date: string; // YYYY-MM-DD
  type: 'cancel' | 'extra' | 'modify' | 'unavailable';
  startTime?: string;
  endTime?: string;
  instructor?: string;
  staffId?: string;
  roomId?: string;
  tableId?: string;
  capacity?: number;
  reason?: string;
}

export interface Workshop {
  id: string;
  title: string;
  slug: string;
  category: string;
  hook: string;
  description: string;
  fullDetails: string;
  duration: string; // e.g. "2 hours"
  ageRange: string; // e.g. "12+ years"
  price: number; // in SAR
  pricingType?: 'Per person' | 'Per pair' | 'Fixed price';
  capacity: number;
  image: string;
  additionalImages?: string[];
  instructor: string;
  staffId?: string;
  room: string;
  roomId?: string;
  tableId?: string;
  materials: string[];
  /** Optional standalone Arabic list (workshops.materials_ar, migration 0038). NOT index-aligned with
   *  materials; shown as a whole in place of it when non-empty and the visitor reads Arabic. */
  materialsAr?: string[];
  whatWeProvide?: string[];
  instructions?: string;
  cancellationPolicy?: string;
  skillLevel?: 'Beginner' | 'Intermediate' | 'Advanced' | 'All Levels';
  status?: 'Draft' | 'Published' | 'Archived';
  featured?: boolean;
  createdAt?: string;
  updatedAt?: string;
  sessions?: WorkshopSession[] | WorkshopSessionRecord[];
  recurringSchedules?: RecurringScheduleRule[];
  sessionExceptions?: SessionException[];
  /**
   * Values for admin-created fields, keyed by the stable fieldKey. Kept even if
   * the field is later disabled, so no historical data is lost.
   */
  customFields?: Record<string, any>;
  /**
   * Optional Arabic versions of the customer-facing copy. Null/absent means
   * "no Arabic version — show the English". See migration 0035.
   */
  titleAr?: string | null;
  hookAr?: string | null;
  descriptionAr?: string | null;
  fullDetailsAr?: string | null;
}

/**
 * Everything the customer submitted on the birthday form, keyed by stable field
 * keys rather than the visible labels — so renaming a label in Settings never
 * makes a previously submitted value unreadable.
 */
export interface BirthdayBookingDetails {
  packageId?: string;
  packageName?: string;
  eventDate?: string;
  eventTime?: string;
  guestCount?: number;
  birthdayPersonName?: string;
  birthdayPersonAge?: string;
  activitySelection?: string;
  cakeOption?: string;
  cakeSize?: string;
  cakePhotoUrl?: string;
  themeOrColors?: string;
  addOns?: string[];
  specialRequests?: string;
  notes?: string;
  termsAccepted?: boolean;
  termsAcceptedAt?: string;
  /** Version of the terms text the customer actually agreed to. */
  termsVersion?: string;
  /** The exact wording shown at acceptance time. */
  termsSnapshot?: string[];
  /** Arabic wording, present only when Arabic terms existed at submit time. */
  termsSnapshotAr?: string[];
  /** Which set the customer was actually shown when they submitted. */
  termsShownLang?: 'en' | 'ar';
  totalAmount?: number;
  depositAmount?: number;
  submittedAt?: string;
  /**
   * Every configurable form field, by stable key, with the label shown at the
   * time of submission. Optional answers are kept, never silently dropped.
   */
  fieldValues?: Array<{
    key: string;
    label: string;
    value: string;
    /** Full-quality submitted image (data URL) for image fields. */
    imageUrl?: string;
  }>;
}

export interface DraftBooking {
  workshopId: string;
  sessionId?: string;
  workshopTitle: string;
  date: string;
  time: string;
  participants: number;
  totalPrice: number;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  /** Present when the draft is a birthday package reservation. */
  birthdayDetails?: BirthdayBookingDetails;
}

export interface CustomerAccount {
  id: string;
  name: string;
  email: string;
  phone: string;
  password?: string;
  source?: 'Website Registration' | 'Workshop Booking' | 'Event Booking' | 'Birthday Package' | 'Live Queue' | 'Admin Created' | 'Walk-in' | string;
  status?: 'Active' | 'VIP' | 'Inactive' | 'Blocked' | string;
  notes?: string;
  /** True once a website account is created for, or linked to, this record. */
  hasAccount?: boolean;
  /** Id of the linked authentication user. The account-type source of truth. */
  userId?: string;
  /** Digits-only national form, the primary returning-customer match key. */
  normalizedPhone?: string;
  /** Phone exactly as entered, for display. */
  displayPhone?: string;
  createdAt: string;
  updatedAt?: string;
  totalSpent?: number;
  /** The site language this customer last used (customers.preferred_lang, migration 0034). Picks the language of outgoing SMS only. */
  preferredLang?: 'en' | 'ar';
}

export interface Booking {
  id: string; // Reference code e.g. "ART-93821"
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  /** The shared customer record this booking belongs to. */
  customerId?: string;
  workshopId: string;
  /** Id of the booked workshop session — the link used to resolve the tutor. */
  sessionId?: string;
  workshopTitle: string;
  date: string; // e.g. "2026-07-20"
  time: string; // e.g. "16:00"
  participants: number;
  totalPrice: number; // in SAR
  source: 'Website' | 'Walk-in' | 'Admin';
  status: 'Pending' | 'Checked In' | 'In Progress' | 'Completed' | 'Cancelled';
  paymentStatus: 'Paid' | 'Unpaid' | 'Refunded' | 'Deposit Paid';
  notes?: string;
  /** Staff member hosting this event/birthday. Ids are stable; the name is
   *  denormalised for display only, exactly as workshop sessions do it. */
  staffId?: string;
  staffName?: string;
  /** Full birthday submission, kept on the one shared booking record. */
  birthdayDetails?: BirthdayBookingDetails;
  createdAt: string;
  timeline: { time: string; action: string }[];
}

export interface QueueItem {
  /**
   * Surrogate key — a uuid, never displayed.
   *
   * This used to be the human-readable "Q-034", generated per DAY, so ids
   * restarted every morning and collided across days. See migration 0030.
   */
  id: string;
  /**
   * The daily sequence staff actually say out loud. Resets each day and is
   * unique within one date, which is the whole reason it cannot be the key.
   * Format for display with formatQueueNumber().
   */
  queueNumber?: number;
  bookingId?: string; // e.g. "ART-10293"
  /** The shared customer record this visit belongs to. */
  customerId?: string;
  name: string;
  phone: string;
  activity: string; // e.g. "Pottery Wheel Workshop" or "Walk-in Clay Play"
  participants: number;
  checkInTime: string; // e.g. "11:15 AM"
  elapsedMinutes: number;
  staffAvatar: string;
  staffName: string;
  staffId?: string;
  status: 'Waiting' | 'Called' | 'In Progress' | 'Completed' | 'Cancelled';
  source: 'Website' | 'Walk-in' | 'Admin';
  type: 'With Instructor' | 'Without Instructor';
  hours?: number;
  /** @deprecated Legacy free-text category; With Instructor entries now link a real session. */
  workshopType?: 'Painting' | 'Wheel' | 'Pottery' | 'Handbuilding' | 'Other';
  date: string; // YYYY-MM-DD
  seatedTime?: string; // ISO string

  // Real record links for With Instructor entries — the tutor is always resolved
  // from these, never from a stored name.
  workshopId?: string;
  sessionId?: string;
  sessionStartTime?: string;
  sessionEndTime?: string;
  sessionDuration?: string;
  sessionCapacity?: number;

  /** Set on an entry created by returning a completed self-guided guest to Waiting. */
  returnedFromQueueId?: string;
  /** Set on the completed entry that was extended; its session record stays intact. */
  extendedByQueueId?: string;

  /**
   * Café table(s) (Studio Resource ids of type 'Table Station') this
   * Without Instructor entry has been given. Staff choose these explicitly —
   * nothing auto-assigns a table. Empty/undefined means unassigned: normal
   * while Waiting or Called, and required before the entry can move to
   * In Progress. See `utils/tableSeatingUtils.ts` for how this drives
   * reserved vs occupied capacity.
   */
  tableIds?: string[];

  history: { status: 'Waiting' | 'Called' | 'In Progress' | 'Completed' | 'Cancelled'; timestamp: string }[];
}

/**
 * The three customer-facing making-stages, then the two end-states.
 *
 * Collected and Broken are lifecycle outcomes rather than Kanban columns or
 * progress-bar steps: a piece leaves the board through them, it does not
 * queue in them, and "Picked Up" is never a fourth step in the customer's
 * 3-stage tracker — see DEFAULT_PIPELINE_STAGES, where 'Collected' is not
 * customer-visible for exactly that reason.
 */
export const PIECE_MAKING_STAGES = [
  'Created', 'First Burn and Colored', 'Ready for Pickup'
] as const;

export const PIECE_END_STATES = ['Collected', 'Broken'] as const;

export type PieceMakingStage = typeof PIECE_MAKING_STAGES[number];
export type PieceStatus = PieceMakingStage | typeof PIECE_END_STATES[number];

/**
 * Where a piece on one of the retired stages lands.
 *
 * Kept as a lookup rather than folded into the SQL migration alone, because
 * older records — and any client that has not reloaded — can still hand us a
 * legacy name. Bisque Firing and Glazing both collapse into the one merged
 * middle stage.
 */
const LEGACY_STAGE_MAP: Record<string, PieceStatus> = {
  'Greenware': 'Created',
  'Drying': 'Created',
  'Created': 'Created',
  'In Processing': 'First Burn and Colored',
  'Firing': 'First Burn and Colored',
  'Bisque Firing': 'First Burn and Colored',
  'Glazing': 'First Burn and Colored',
  'Ready for Collection': 'Ready for Pickup',
  'Ready for Pickup': 'Ready for Pickup',
  'Collected': 'Collected',
  'Broken': 'Broken'
};

/** Normalises any stage name — current or retired — onto a valid status. */
export function migrateLegacyPieceStatus(status: string | undefined | null): PieceStatus {
  if (!status) return 'Created';
  const all: string[] = [...PIECE_MAKING_STAGES, ...PIECE_END_STATES];
  if (all.includes(status)) return status as PieceStatus;
  return LEGACY_STAGE_MAP[status] || 'Created';
}

export interface PotteryPiece {
  id: string; // e.g. "PC-8802"
  pieceCode?: string; // e.g. "AC-8802"
  name: string;
  workshopName: string;
  /**
   * The workshop this piece came from. The customer's My Pieces page shows this
   * workshop's cover photo — the photo on the piece itself is the studio's own
   * working shot and is never shown to them.
   */
  workshopId?: string;
  customerName: string;
  customerPhone: string;
  customerId?: string;
  dateCreated: string;
  image: string;
  status: PieceStatus;
  /**
   * The pipeline_stages row this piece is in (0045). The database keeps
   * `status` equal to that stage's name, so either can be written; older rows
   * cached before 0045 may not carry it yet.
   */
  stageId?: string;
  daysElapsed: number;
  assignedStaff: string;
  /** Internal-only damage note for a Broken piece. Never sent to the customer. */
  damageNote?: string;
  storageLocation?: string;
  notes?: string;
  additionalDescriptionGlazingNotes?: string;
  expectedCompletion?: string;
  expectedReadyDate?: string;
  /** Set when the piece actually reached Ready for Pickup. */
  actualReadyDate?: string;
  /** Legacy alias kept on older records. */
  readyDate?: string;
  /** Date the piece was handed over. */
  collectionDate?: string;
  /** Last pickup reminder sent, so the dashboard does not nag daily. */
  lastNotificationDate?: string;
  history?: {
    /** The stage's name when the entry was written; kept as written. */
    status: string;
    /** The stage the entry refers to (0045); absent for a name no stage has. */
    stageId?: string;
    timestamp: string;
    /** Riyadh-local date/time the change was recorded, e.g. "2026-08-03 04:15 PM". */
    riyadhTime?: string;
    user: string;
    reason?: string;
  }[];
  [key: string]: any;
}

export interface NotificationItem {
  id: string;
  type: 'customer' | 'staff';
  customerPhone?: string;
  title: string;
  message: string;
  pieceId?: string;
  pieceName?: string;
  newStatus?: string;
  performedBy?: string;
  timestamp: string;
  isRead: boolean;
  highlighted?: boolean;
}

export interface TestResult {
  id: string;
  name: string;
  category:
    | 'Validation'
    | 'Dashboard'
    | 'Live Queue'
    | 'Bookings'
    | 'Workshops'
    | 'Events'
    | 'Customers'
    | 'Pieces'
    | 'Staff'
    | 'Settings'
    | 'Roles & Access'
    | 'Data Integrity';
  description: string;
  duration: number; // ms
  status: 'passed' | 'failed' | 'skipped';
  expected?: string;
  actual?: string;
  failureMessage?: string;
}

import { getRelativeRiyadhDateStr } from './utils/dateUtils';

// Initial robust seed data
export const INITIAL_WORKSHOPS: Workshop[] = [
  {
    id: 'ws-1',
    title: 'Wheel Throwing Masterclass',
    slug: 'wheel-throwing-masterclass',
    category: 'Pottery',
    hook: 'Spin, mold, and fire your very first clay bowl on the potter’s wheel.',
    description: 'Learn the foundational techniques of wheel throwing from our expert ceramicists.',
    fullDetails: 'Perfect for complete beginners! In this 2.5-hour workshop, you will learn to center clay on the wheel, pull walls, and shape your own bowls or cups. We use premium local terracotta clay. After your piece dries, we glaze and fire it in our kiln, ready for pickup in 10-14 days.',
    duration: '2.5 Hours',
    ageRange: '16+ years',
    price: 320,
    capacity: 8,
    image: 'https://images.unsplash.com/photo-1565192647048-f997ded87958?auto=format&fit=crop&w=800&q=80',
    instructor: 'Ali bin Khalid',
    room: 'The Clay Station (Studio A)',
    materials: ['Terracotta Clay', 'Apron', 'Trimming Tools', 'Kiln Firing & Glazing'],
    skillLevel: 'Beginner',
    status: 'Published',
    sessions: [
      { id: 1, date: getRelativeRiyadhDateStr(0), time: '11:00 AM', capacity: 8, isFull: true },
      { id: 2, date: getRelativeRiyadhDateStr(1), time: '04:30 PM', capacity: 8, isFull: false },
      { id: 3, date: getRelativeRiyadhDateStr(2), time: '07:30 PM', capacity: 8, isFull: false }
    ]
  },
  {
    id: 'ws-2',
    title: 'Hand-Building Ceramics',
    slug: 'hand-building-ceramics',
    category: 'Pottery',
    hook: 'Pinch, coil, and slab-build beautiful plates and functional art pieces.',
    description: 'A meditative introduction to handcrafting pottery without a wheel.',
    fullDetails: 'Discover the ancient art of hand-building. You’ll learn pinching, coiling, and slab construction techniques to create customizable mugs, trinket dishes, or planters. Great for socializing and unleashing tactile creativity.',
    duration: '2.0 Hours',
    ageRange: '12+ years',
    price: 240,
    capacity: 12,
    image: 'https://images.unsplash.com/photo-1595435934249-5df7ed86e1c0?auto=format&fit=crop&w=800&q=80',
    instructor: 'Aisha Al-Jahdali',
    room: 'The Handcraft Lounge',
    materials: ['Stoneware Clay', 'Texture Stamps', 'Engobes & Glazes', 'Firing included'],
    skillLevel: 'Beginner',
    status: 'Published',
    sessions: [
      { id: 1, date: getRelativeRiyadhDateStr(0), time: '01:00 PM', capacity: 12, isFull: false }
    ]
  },
  {
    id: 'ws-3',
    title: 'Acrylic Landscape Painting',
    slug: 'acrylic-landscape-painting',
    category: 'Painting',
    hook: 'Capture the majestic beauty of AlUla landscapes on canvas.',
    description: 'A vibrant acrylic painting session guided step-by-step by local painters.',
    fullDetails: 'Bring the gorgeous warm colors of Saudi Arabia to life. Our artist will guide you in blending sunset hues, detailing sand dunes, and structuring rocks. No prior painting experience required. Sip specialty coffee and paint away!',
    duration: '3.0 Hours',
    ageRange: '14+ years',
    price: 280,
    capacity: 15,
    image: 'https://images.unsplash.com/photo-1460661419201-fd4cecdf8a8b?auto=format&fit=crop&w=800&q=80',
    instructor: 'Faisal Al-Otaibi',
    room: 'The Canvas Atelier (Studio B)',
    materials: ['40x50cm Canvas', 'Artist-grade Acrylics', 'Brushes & Easel', 'Café Drink'],
    skillLevel: 'All Levels',
    status: 'Published',
    sessions: [
      { id: 1, date: getRelativeRiyadhDateStr(0), time: '06:00 PM', capacity: 15, isFull: true }
    ]
  },
  {
    id: 'ws-4',
    title: 'Kids Clay Creatures',
    slug: 'kids-clay-creatures',
    category: 'Kids',
    hook: 'Let your child’s imagination run wild with soft air-dry clay sculpting.',
    description: 'A playful and safe molding workshop designed especially for little hands.',
    fullDetails: 'A high-energy, fun-filled class where kids learn basic sculpting, pinching, and painting. They will make colorful dinosaurs, fairy houses, or friendly monsters to take home on the same day!',
    duration: '1.5 Hours',
    ageRange: '6-11 years',
    price: 180,
    capacity: 10,
    image: 'https://images.unsplash.com/photo-1513364776144-60967b0f800f?auto=format&fit=crop&w=800&q=80',
    instructor: 'Sara Al-Malki',
    room: 'Kids Creative Corner',
    materials: ['Safe Air-Dry Clay', 'Kid-friendly Clay Tools', 'Acrylic paints', 'Kids juice box'],
    skillLevel: 'Beginner',
    status: 'Published',
    sessions: [
      { id: 1, date: getRelativeRiyadhDateStr(1), time: '10:00 AM', capacity: 10, isFull: false }
    ]
  },
  {
    id: 'ws-5',
    title: 'Couples Pottery & Coffee Date',
    slug: 'couples-pottery-coffee',
    category: 'Couples',
    hook: 'A romantic evening of joint-throwing and artisanal Jeddah coffee.',
    description: 'Create memorable matching coffee mugs alongside your significant other.',
    fullDetails: 'Designed for pairs! Work together on adjacent potter wheels. Learn to center clay and help each other shape matching coffee mugs. Each ticket includes professional instruction, clay for two, firing services, and two premium specialty hot drinks from our espresso bar.',
    duration: '2.5 Hours',
    ageRange: '18+ years',
    price: 550, // Per couple
    capacity: 6, // 6 couples
    image: 'https://images.unsplash.com/photo-1513151233558-d860c5398176?auto=format&fit=crop&w=800&q=80',
    instructor: 'Ali bin Khalid',
    room: 'The Clay Station (Studio A)',
    materials: ['Double portion Clay', 'Mug Trimming Tools', 'Underglazes', '2 Specialty Coffees'],
    skillLevel: 'All Levels',
    status: 'Published',
    sessions: [
      { id: 1, date: getRelativeRiyadhDateStr(0), time: '06:00 PM', capacity: 6, isFull: false }
    ]
  }
];

export const INITIAL_BOOKINGS: Booking[] = [
  {
    id: 'ART-82941',
    customerName: 'Noura Al-Amri',
    customerEmail: 'noura.amri@outlook.com',
    customerPhone: '+966 50 123 4567',
    workshopId: 'ws-1',
    workshopTitle: 'Wheel Throwing Masterclass',
    date: getRelativeRiyadhDateStr(0),
    time: '16:00',
    participants: 2,
    totalPrice: 640,
    source: 'Website',
    status: 'Pending',
    paymentStatus: 'Paid',
    createdAt: `${getRelativeRiyadhDateStr(-1)} 14:32`,
    timeline: [
      { time: '14:32', action: 'Booking created on website' },
      { time: '14:33', action: 'Online payment captured successfully' }
    ]
  },
  {
    id: 'ART-10394',
    customerName: 'Yasser Qahtani',
    customerEmail: 'yasser@qahtani.sa',
    customerPhone: '+966 54 987 6543',
    workshopId: 'ws-2',
    workshopTitle: 'Hand-Building Ceramics',
    date: getRelativeRiyadhDateStr(0),
    time: '11:00',
    participants: 1,
    totalPrice: 240,
    source: 'Walk-in',
    status: 'Checked In',
    paymentStatus: 'Paid',
    createdAt: `${getRelativeRiyadhDateStr(0)} 10:45`,
    timeline: [
      { time: '10:45', action: 'Walk-in booking created at front desk' },
      { time: '10:45', action: 'Payment completed via POS (Credit Card)' },
      { time: '10:50', action: 'Customer checked in and directed to The Handcraft Lounge' }
    ]
  },
  {
    id: 'ART-99201',
    customerName: 'Sarah Johansson',
    customerEmail: 'sarah.j@gmail.com',
    customerPhone: '+966 56 111 2222',
    workshopId: 'ws-3',
    workshopTitle: 'Acrylic Landscape Painting',
    date: getRelativeRiyadhDateStr(0),
    time: '18:00',
    participants: 3,
    totalPrice: 840,
    source: 'Website',
    status: 'Pending',
    paymentStatus: 'Paid',
    createdAt: `${getRelativeRiyadhDateStr(-2)} 09:12`,
    timeline: [
      { time: '09:12', action: 'Booking created on website' },
      { time: '09:13', action: 'Online payment captured' }
    ]
  },
  {
    id: 'ART-77210',
    customerName: 'Mohammed Al-Saeed',
    customerEmail: 'm.saeed@gmail.com',
    customerPhone: '+966 55 444 5555',
    workshopId: 'ws-1',
    workshopTitle: 'Wheel Throwing Masterclass',
    date: getRelativeRiyadhDateStr(2),
    time: '16:00',
    participants: 1,
    totalPrice: 320,
    source: 'Admin',
    status: 'Pending',
    paymentStatus: 'Unpaid',
    notes: 'Requested back-row seat if possible. Needs to pay at the counter.',
    createdAt: `${getRelativeRiyadhDateStr(0)} 08:30`,
    timeline: [
      { time: '08:30', action: 'Admin created draft booking' }
    ]
  }
];

export const INITIAL_QUEUE: QueueItem[] = [
  {
    id: 'Q-001',
    bookingId: 'ART-10293',
    name: 'Abdulrahman Al-Fassi',
    phone: '+966 50 222 3333',
    activity: 'Wheel Throwing Masterclass',
    participants: 2,
    checkInTime: '10:30 AM',
    elapsedMinutes: 22,
    staffAvatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=150&h=150&q=80',
    staffName: 'Ali bin Khalid',
    // Real record links — the tutor is resolved from these, not from staffName.
    staffId: 'staff-1',
    workshopId: 'ws-1',
    sessionId: 'sess-ws1-1',
    sessionStartTime: '11:00 AM',
    sessionCapacity: 8,
    status: 'Waiting',
    source: 'Website',
    type: 'With Instructor',
    date: getRelativeRiyadhDateStr(0),
    history: [
      { status: 'Waiting', timestamp: new Date().toISOString() }
    ]
  },
  {
    id: 'Q-002',
    name: 'Fatima Al-Harbi',
    phone: '+966 53 444 8888',
    activity: 'Walk-in Clay Play',
    participants: 1,
    checkInTime: '10:42 AM',
    elapsedMinutes: 10,
    staffAvatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&h=150&q=80',
    staffName: 'Self-guided',
    status: 'Waiting',
    source: 'Walk-in',
    type: 'Without Instructor',
    hours: 2,
    date: getRelativeRiyadhDateStr(0),
    history: [
      { status: 'Waiting', timestamp: new Date().toISOString() }
    ]
  },
  {
    id: 'Q-003',
    name: 'Yasser Qahtani',
    phone: '+966 54 987 6543',
    activity: 'Hand-Building Ceramics',
    participants: 1,
    checkInTime: '10:45 AM',
    elapsedMinutes: 7,
    staffAvatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&h=150&q=80',
    staffName: 'Self-guided',
    status: 'In Progress',
    source: 'Walk-in',
    type: 'Without Instructor',
    hours: 1,
    date: getRelativeRiyadhDateStr(0),
    seatedTime: new Date().toISOString(),
    history: [
      { status: 'Waiting', timestamp: new Date().toISOString() },
      { status: 'In Progress', timestamp: new Date().toISOString() }
    ]
  }
];

export const INITIAL_PIECES: PotteryPiece[] = [
  {
    id: 'PC-201',
    name: 'Turquoise Ribbed Mug',
    workshopName: 'Wheel Throwing Masterclass',
    customerName: 'Rania Al-Sharif',
    customerPhone: '+966 50 112 3344',
    dateCreated: '2026-07-05',
    image: 'https://images.unsplash.com/photo-1595435934249-5df7ed86e1c0?auto=format&fit=crop&w=200&q=80',
    status: 'Ready for Pickup',
    daysElapsed: 14,
    assignedStaff: 'Ali Khalid',
    storageLocation: 'Shelf C-12',
    notes: 'Beautiful glaze finish. Handle is well attached.'
  },
  {
    id: 'PC-202',
    name: 'Sage Green Bowl',
    workshopName: 'Hand-Building Ceramics',
    customerName: 'Yousef Al-Ghamdi',
    customerPhone: '+966 54 888 7777',
    dateCreated: '2026-07-12',
    image: 'https://images.unsplash.com/photo-1578749556568-bc2c40e68b61?auto=format&fit=crop&w=200&q=80',
    status: 'First Burn and Colored',
    daysElapsed: 7,
    assignedStaff: 'Aisha Al-Jahdali',
    storageLocation: 'Kiln Room 2',
    notes: 'Secondary firing in progress.'
  },
  {
    id: 'PC-203',
    name: 'Miniature Cactus Planter',
    workshopName: 'Kids Clay Creatures',
    customerName: 'Talal Al-Amri',
    customerPhone: '+966 50 123 4567',
    dateCreated: '2026-07-18',
    image: 'https://images.unsplash.com/photo-1513519245088-0e12902e5a38?auto=format&fit=crop&w=200&q=80',
    status: 'Created',
    daysElapsed: 1,
    assignedStaff: 'Sara Al-Malki',
    storageLocation: 'Drying Rack B',
    notes: 'Air drying. Delicate features.'
  },
  {
    id: 'PC-204',
    name: 'Symmetrical Terracotta Pitcher',
    workshopName: 'Wheel Throwing Masterclass',
    customerName: 'Bassem Yamani',
    customerPhone: '+966 55 999 1111',
    dateCreated: '2026-07-02',
    image: 'https://images.unsplash.com/photo-1565192647048-f997ded87958?auto=format&fit=crop&w=200&q=80',
    status: 'Ready for Pickup',
    daysElapsed: 17,
    assignedStaff: 'Ali Khalid',
    storageLocation: 'Shelf C-03',
    notes: 'Slightly heavy base, but gorgeous organic rim.'
  },
  {
    id: 'PC-205',
    name: 'Abstract Paint Canvas (Sealed)',
    workshopName: 'Acrylic Landscape Painting',
    customerName: 'Hessa Al-Subaie',
    customerPhone: '+966 56 222 3344',
    dateCreated: '2026-07-15',
    image: 'https://images.unsplash.com/photo-1460661419201-fd4cecdf8a8b?auto=format&fit=crop&w=200&q=80',
    status: 'Collected',
    daysElapsed: 4,
    assignedStaff: 'Faisal Al-Otaibi',
    storageLocation: 'Delivered',
    notes: 'Customer extremely pleased!'
  }
];

// The System Health suite is no longer a hardcoded list. Real tests that
// execute against the database live in src/utils/systemTests.ts.

/**
 * One pottery pipeline stage. This is the single configuration the Pottery
 * Pieces page, the logging console, the tracker, the filters and the customer
 * view all read — there is no second hardcoded status list.
 */
export interface PipelineStage {
  id: string;
  name: string;
  color: string;
  order: number;
  visibleToCustomer: boolean;
  /** Disabled stages stay valid for historical pieces but cannot be selected. */
  enabled?: boolean;
  /** Optional customer-facing wording; falls back to `name`. */
  customerLabel?: string;
  /** Whether moving a piece into this stage notifies the customer. */
  notifyCustomer?: boolean;
  /** Set on the five system stages (0045); null for a custom stage. Behaviour keys on this, never on the name. */
  systemKey?: StageSystemKey | null;
  /** Optional Arabic stage name; falls back to `name`. */
  nameAr?: string | null;
  /** Optional Arabic customer-facing wording; falls back to `customerLabel`. */
  customerLabelAr?: string | null;
}

/** The fixed key of each system stage (pipeline_stages.system_key). */
export type StageSystemKey = 'created' | 'kiln' | 'ready' | 'collected' | 'broken';

/**
 * The pottery workflow: three customer-facing making-stages, then the two
 * end-states.
 *
 * These ids are the canonical set — `0007_piece_lifecycle_v3.sql` deletes
 * everything else in `pipeline_stages` (the old, now-merged 'stage-glazing'
 * row included), which is what clears duplicated and retired rows the board
 * was drawing twice. Staff can rename, recolour and reorder them in Settings;
 * the ids are what stays fixed.
 *
 * 'Collected' stays `visibleToCustomer: false`: it is a real, final status a
 * piece can hold and it still drives its own notification and history entry,
 * but "Picked Up" is a recorded outcome, not a fourth step in the customer's
 * 3-stage progress tracker (see the `customerStages` filter wherever the
 * tracker is rendered).
 */
export const DEFAULT_PIPELINE_STAGES: PipelineStage[] = [
  { id: 'stage-greenware', name: 'Created', color: '#E07A5F', order: 0, visibleToCustomer: true, enabled: true, notifyCustomer: true, systemKey: 'created' },
  { id: 'stage-bisque', name: 'First Burn and Colored', color: '#F2CC8F', order: 1, visibleToCustomer: true, enabled: true, notifyCustomer: true, systemKey: 'kiln' },
  { id: 'stage-ready', name: 'Ready for Pickup', color: '#335C67', order: 2, visibleToCustomer: true, enabled: true, notifyCustomer: true, systemKey: 'ready' },
  // End-states. On the board these are outcomes, not columns, and neither is
  // a step in the customer's 3-stage tracker.
  { id: 'stage-collected', name: 'Collected', color: '#111111', order: 3, visibleToCustomer: false, enabled: true, notifyCustomer: true, systemKey: 'collected' },
  // The customer is told to contact the café, never shown the damage details.
  { id: 'stage-broken', name: 'Broken', color: '#B91C1C', order: 4, visibleToCustomer: false, enabled: true, notifyCustomer: true, systemKey: 'broken' }
];

/** A stage is selectable for a new update unless it has been disabled. */
export function isStageEnabled(stage: PipelineStage): boolean {
  return stage.enabled !== false;
}

/** Wording shown to the customer for a stage. */
export function stageCustomerLabel(stage: PipelineStage): string {
  return stage.customerLabel?.trim() || stage.name;
}

export interface StaffWeeklyShift {
  id?: string;
  isWorking: boolean;
  startTime: string;
  endTime: string;
  breakStart?: string;
  breakEnd?: string;
}

/**
 * A single day of a staff member's saved weekly schedule.
 * Holds zero or more shifts so a staff member can work multiple shifts per day.
 */
export interface StaffDaySchedule {
  isWorking: boolean;
  shifts: StaffWeeklyShift[];
}

/**
 * Day entries are read as either the multi-shift form or the legacy single-shift
 * form. All writes use StaffDaySchedule; use getDayShifts() to read either shape.
 */
export type StaffScheduleDayEntry = StaffDaySchedule | StaffWeeklyShift;

export interface StaffTimeOff {
  id: string;
  startDate: string;
  endDate: string;
  reason: string;
  status: 'Approved' | 'Pending' | 'Rejected';
}

export type StaffRole = 'Super Admin' | 'Admin' | 'Staff';

export interface StaffMember {
  id: string;
  name: string;
  profileImage?: string;
  countryCode?: string;
  phone: string;
  email: string;
  position: string;
  skills?: string[];
  status: 'Active' | 'On Leave' | 'Inactive' | 'Former Staff';
  weeklySchedule?: Record<string, StaffScheduleDayEntry>; // Key: 'Sunday', 'Monday', etc. Empty by default for new staff.
  breakPeriods?: { name: string; startTime: string; endTime: string }[];
  timeOff?: StaffTimeOff[];
  notes?: string;
  canAssignWorkshops?: boolean;
  canAssignPieces?: boolean;

  // ---- Admin Console account ----
  /** Super Admin has unrestricted access; the role itself grants it. */
  role?: StaffRole;
  /** Admin Console page ids this staff member may open. Ignored for Super Admin. */
  permissions?: string[];
  /** Whether this staff member can sign in to the Admin Console at all. */
  hasConsoleAccess?: boolean;
  /** Console credential. A staff profile may exist with no login account. */
  password?: string;
  /** True while the password is the auto-provisioned bootstrap one. */
  passwordIsTemporary?: boolean;
  /** Stable id of the linked console user; equals staff.id when linked. */
  userId?: string;
  /** Digits-only national phone, so login accepts any entered format. */
  normalizedPhone?: string;
  lastLoginAt?: string;

  createdAt?: string;
  updatedAt?: string;
}

/**
 * The single shared birthday-package record. The Staff Console edits it and the
 * customer site renders from it — there is no second copy of these details.
 */
export interface BirthdayCakeSize {
  id: string;
  /** e.g. "Small (15 cm)" */
  label: string;
  /** Optional Arabic display name. `label` stays the matched/stored value. */
  labelAr?: string;
  price: number;
}

export interface BirthdayPackage {
  id: string;
  name: string;
  image: string;
  shortDescription: string;
  fullDescription: string;
  /** Optional Arabic versions; null/absent means show the English. See migration 0035. */
  nameAr?: string | null;
  shortDescriptionAr?: string | null;
  fullDescriptionAr?: string | null;
  /** Optional Arabic versions (migration 0037); null/absent means show the English. */
  pricingLabelAr?: string | null;
  durationAr?: string | null;
  ageInformationAr?: string | null;
  cakeDescriptionAr?: string | null;
  trainerInfoAr?: string | null;
  deliveryInfoAr?: string | null;
  customerNotesAr?: string | null;
  termsAr?: string | null;
  /** Optional standalone Arabic lists (migration 0039). NOT index-aligned with the English lists;
   *  each is shown as a whole in place of its English twin when non-empty and the visitor reads Arabic. */
  includedItemsAr?: string[];
  activityChoicesAr?: string[];
  additionalInfoAr?: string[];

  price: number;
  pricingType: 'Per child' | 'Per person' | 'Fixed price';
  /** Customer-visible pricing label, e.g. "Per person". */
  pricingLabel?: string;

  duration: string; // e.g. "2 Hours"
  minGuests: number;
  maxGuests: number;
  ageInformation: string;

  /** The "Includes:" list — decorations, beverages, table reservation, etc. */
  includedItems: string[];
  /** The "Your choice of one activity" list. */
  activityChoices: string[];
  /** Extra notes shown under the activities, e.g. firing and collection details. */
  additionalInfo: string[];

  /** Customized cake block. */
  cakeDescription: string;
  cakeSizes: BirthdayCakeSize[];

  /** e.g. "Includes Professional Trainer/Artist upon request." */
  trainerInfo: string;
  /** e.g. "Pottery will be delivered or collected after firing." */
  deliveryInfo: string;

  availableDays: string[];
  availableTimes: string[];
  terms: string;
  customerNotes: string;
  depositAmount?: number;

  status: 'Published' | 'Draft';
  displayOrder: number;
  createdAt?: string;
  updatedAt?: string;

  /** @deprecated Folded into includedItems by normalizeBirthdayPackage(). */
  includedActivities?: string[];
  /** @deprecated */
  includedMaterials?: string[];
  /** @deprecated */
  foodAndBeverages?: string[];
  /** @deprecated */
  decorations?: string[];
}

/** Cake pricing is identical across packages unless staff change it. */
export const DEFAULT_CAKE_SIZES: BirthdayCakeSize[] = [
  { id: 'cake-s', label: 'Small (15 cm)', price: 350 },
  { id: 'cake-m', label: 'Medium (25 cm)', price: 650 },
  { id: 'cake-l', label: 'Large (35 cm)', price: 800 }
];

/**
 * Fills in the structured fields for records saved before they existed, so the
 * customer site always has one consistent shape to render.
 */
export function normalizeBirthdayPackage(pkg: BirthdayPackage): BirthdayPackage {
  const includedItems = pkg.includedItems?.length
    ? pkg.includedItems
    : [...(pkg.decorations || []), ...(pkg.foodAndBeverages || []), ...(pkg.includedMaterials || [])];

  return {
    ...pkg,
    includedItems,
    activityChoices: pkg.activityChoices?.length ? pkg.activityChoices : (pkg.includedActivities || []),
    additionalInfo: pkg.additionalInfo || [],
    cakeSizes: pkg.cakeSizes?.length ? pkg.cakeSizes : DEFAULT_CAKE_SIZES,
    cakeDescription: pkg.cakeDescription || '',
    trainerInfo: pkg.trainerInfo || '',
    deliveryInfo: pkg.deliveryInfo || '',
    pricingLabel: pkg.pricingLabel || (pkg.pricingType === 'Fixed price' ? 'Fixed price' : pkg.pricingType)
  };
}

/** A field on the customer birthday booking form, configured in Settings → Events/Birthday. */
export interface BirthdayFormField {
  id: string;
  key: string;
  label: string;
  type: 'short_text' | 'long_text' | 'number' | 'date' | 'time' | 'phone' | 'dropdown' | 'package' | 'image';
  placeholder?: string;
  helpText?: string;
  options?: string[];
  required: boolean;
  enabled: boolean;
  order: number;
  /** Core fields back the existing booking logic and cannot be deleted. */
  system?: boolean;
}

/**
 * Default birthday booking form layout — mirrors the fields the form has always
 * shown. Staff can relabel, reorder, disable or extend these in Settings.
 */
export const DEFAULT_BIRTHDAY_FORM_FIELDS: BirthdayFormField[] = [
  { id: 'bf-1', key: 'bookingName', label: 'Booking Name', type: 'short_text', placeholder: 'e.g. Noura Al-Amri', required: true, enabled: true, order: 0, system: true },
  { id: 'bf-2', key: 'phone', label: 'Phone Number', type: 'phone', required: true, enabled: true, order: 1, system: true },
  { id: 'bf-3', key: 'numberOfPeople', label: 'Number of People', type: 'number', required: true, enabled: true, order: 2, system: true },
  { id: 'bf-4', key: 'package', label: 'Package', type: 'package', required: true, enabled: true, order: 3, system: true },
  { id: 'bf-5', key: 'bookingDate', label: 'Date / Day', type: 'date', required: true, enabled: true, order: 4, system: true },
  { id: 'bf-6', key: 'bookingTime', label: 'Time', type: 'time', required: true, enabled: true, order: 5, system: true },
  {
    id: 'bf-7', key: 'balloonColor', label: 'Pick a balloon colour 🎈', type: 'dropdown', required: false, enabled: true, order: 6,
    options: ['Pink & White', 'Pastel Blue & White', 'Gold & Cream', 'Rose Gold & Blush', 'Sage Green & Neutral', 'Rainbow Multi-Color', 'Custom Mix']
  },
  {
    id: 'bf-8', key: 'drinksChoice', label: 'Choose your drinks', type: 'dropdown', required: false, enabled: true, order: 7,
    options: [
      'Fresh Juices (Orange, Lemonade, Watermelon)',
      'Specialty Coffee Bar (Latte, Cappuccino, Spanish Latte)',
      'Mixed Bar (Coffee & Fresh Juices)'
    ]
  },
  { id: 'bf-9', key: 'birthdayPersonName', label: 'Name of the Birthday Person', type: 'short_text', placeholder: 'e.g. Maya (Turning 8!)', required: true, enabled: true, order: 8 },
  { id: 'bf-10', key: 'cakePhoto', label: 'Please attach a photo of the cake', type: 'image', helpText: 'Send us your customized cake design photo and we will prepare it for you!', required: false, enabled: true, order: 9 }
];

/**
 * Seed content for the shared package records. The Staff Console edits these and
 * the customer site renders them — there is no second copy anywhere.
 */
export const DEFAULT_BIRTHDAY_PACKAGES: BirthdayPackage[] = [
  {
    id: 'bpkg-1',
    name: 'Canvas & Create',
    image: 'https://images.unsplash.com/photo-1513151233558-d860c5398176?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Pre-sketched canvas, acrylic painting, balloons and studio decor.',
    fullDescription: 'A creative celebration in our studio: private space, your choice of one painting activity per person, balloon decoration and complimentary beverages.',
    price: 165,
    pricingType: 'Per person',
    pricingLabel: 'Per person',
    duration: '2 Hours',
    minGuests: 5,
    maxGuests: 20,
    ageInformation: '4+ years',
    includedItems: [
      'Studio decorations: balloons and setup',
      'Complimentary beverages',
      'Table reservation'
    ],
    activityChoices: [
      'Canvas Painting (Size 85)',
      'Pre-made Pottery Painting',
      '3D Figures Painting',
      'Tote Bag Painting'
    ],
    additionalInfo: [],
    cakeDescription: 'Send us your cake design and we will do it.',
    cakeSizes: [
      { id: 'cake-s', label: 'Small (15 cm)', price: 350 },
      { id: 'cake-m', label: 'Medium (25 cm)', price: 650 },
      { id: 'cake-l', label: 'Large (35 cm)', price: 800 }
    ],
    trainerInfo: 'Includes Professional Trainer/Artist upon request.',
    deliveryInfo: '',
    availableDays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Saturday'],
    availableTimes: ['10:00 AM', '01:00 PM', '04:00 PM', '07:00 PM'],
    terms: 'A 500 SAR deposit is required to confirm the booking. Changes or cancellations must be made at least four days before the scheduled date to receive a refund of the deposit. Bringing outside food or drinks is not allowed.',
    customerNotes: '',
    depositAmount: 500,
    status: 'Published',
    displayOrder: 0
  },
  {
    id: 'bpkg-2',
    name: 'Pottery Party',
    image: 'https://images.unsplash.com/photo-1595435934249-5df7ed86e1c0?auto=format&fit=crop&w=800&q=80',
    shortDescription: 'Handbuilding clay, wheel throwing, firing service and studio decor.',
    fullDescription: 'A hands-on clay celebration: private studio space, your choice of one pottery activity per person, balloon decoration and complimentary beverages.',
    price: 200,
    pricingType: 'Per person',
    pricingLabel: 'Per person',
    duration: '2.5 Hours',
    minGuests: 5,
    maxGuests: 20,
    ageInformation: '6+ years',
    includedItems: [
      'Studio decorations: balloons and setup',
      'Complimentary beverages',
      'Table reservation'
    ],
    activityChoices: [
      'Hand-made Pottery Making',
      'Wheel Throwing'
    ],
    additionalInfo: [
      'Both activities include pottery coloring and firing.',
      'Pottery will be delivered or collected after firing.'
    ],
    cakeDescription: 'Send us your cake design and we will do it.',
    cakeSizes: [
      { id: 'cake-s', label: 'Small (15 cm)', price: 350 },
      { id: 'cake-m', label: 'Medium (25 cm)', price: 650 },
      { id: 'cake-l', label: 'Large (35 cm)', price: 800 }
    ],
    trainerInfo: 'Includes Professional Trainer/Artist.',
    deliveryInfo: 'Pottery will be delivered or collected after firing.',
    availableDays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Saturday'],
    availableTimes: ['10:00 AM', '01:00 PM', '04:00 PM', '07:00 PM'],
    terms: 'A 500 SAR deposit is required to confirm the booking. Changes or cancellations must be made at least four days before the scheduled date to receive a refund of the deposit. Bringing outside food or drinks is not allowed.',
    customerNotes: '',
    depositAmount: 500,
    status: 'Published',
    displayOrder: 1
  }
];

/**
 * A bookable studio resource — a room or a table station.
 *
 * This is the single shared record used by Settings, the workshop Monthly
 * Schedule, the session calendar, saved sessions, events and every availability
 * check. Sessions store the stable `id`, never just the display name.
 */
export interface StudioResource {
  id: string;
  name: string;
  type: 'Studio Room' | 'Table Station';
  seats: number;
  location?: string;
  notes?: string;
  status: 'Active' | 'Inactive' | 'Maintenance';
  order: number;
  createdAt?: string;
  updatedAt?: string;
}

/** Only Active resources can take a new assignment. */
export function isAssignableResource(resource: Pick<StudioResource, 'status'>): boolean {
  return resource.status === 'Active';
}

export const DEFAULT_STUDIO_RESOURCES: StudioResource[] = [
  { id: 'res-room-1', name: 'Studio Room 1', type: 'Studio Room', seats: 12, location: 'Ground floor', status: 'Active', order: 0 },
  { id: 'res-room-2', name: 'Studio Room 2', type: 'Studio Room', seats: 10, location: 'Ground floor', status: 'Active', order: 1 },
  { id: 'res-table-1', name: 'Table Station 1', type: 'Table Station', seats: 4, location: 'Main lounge', status: 'Active', order: 2 },
  { id: 'res-table-2', name: 'Table Station 2', type: 'Table Station', seats: 4, location: 'Main lounge', status: 'Active', order: 3 }
];


// ============================================================================
// WORKSHOP FIELD CONFIGURATION
// The two Workshop cards are rendered from these records, so the admin controls
// the whole field structure — not just dropdown contents.
// ============================================================================

export type WorkshopFieldType =
  | 'short_text'
  | 'long_text'
  | 'rich_text'
  | 'number'
  | 'dropdown'
  | 'multi_select'
  | 'tags'
  | 'checkbox'
  | 'date'
  | 'time';

export type WorkshopCardSection = 'curriculum' | 'logistics';

/** Live records that supply a field's options; never a manual list. */
export type WorkshopFieldDataSource = 'staff' | 'studio-resources';

export interface WorkshopFieldConfig {
  fieldId: string;
  /** Stable key. Renaming the label never changes this, so saved values survive. */
  fieldKey: string;
  cardSection: WorkshopCardSection;
  label: string;
  fieldType: WorkshopFieldType;
  placeholder?: string;
  required: boolean;
  enabled: boolean;
  displayOrder: number;
  options?: string[];
  customerVisible: boolean;

  /**
   * Core fields are bound to a real Workshop property. They can be renamed,
   * reordered, hidden and made optional, but not deleted or retyped — their
   * values are typed columns the rest of the app relies on.
   */
  system?: boolean;
  boundTo?: keyof Workshop | string;
  /** Options come from live records rather than the `options` array. */
  dataSource?: WorkshopFieldDataSource;

  createdAt?: string;
  updatedAt?: string;
}

/**
 * The existing hardcoded fields of both Workshop cards, migrated into
 * configuration. Order matches the cards as they render today.
 */
export const DEFAULT_WORKSHOP_FIELDS: WorkshopFieldConfig[] = [
  // ---- Workshop Curriculum basics ----
  { fieldId: 'wf-title', fieldKey: 'title', cardSection: 'curriculum', label: 'Workshop Title',
    fieldType: 'short_text', placeholder: 'e.g. Traditional Arabic Calligraphy Glazing',
    required: true, enabled: true, displayOrder: 0,
    customerVisible: true, system: true, boundTo: 'title' },

  { fieldId: 'wf-category', fieldKey: 'category', cardSection: 'curriculum', label: 'Category',
    fieldType: 'dropdown', required: true, enabled: true, displayOrder: 1,
    customerVisible: true, system: true, boundTo: 'category' },

  { fieldId: 'wf-hook', fieldKey: 'hook', cardSection: 'curriculum', label: 'One-Line Hook (Subtext)',
    fieldType: 'short_text', placeholder: 'e.g. Mold clay on the wheel and paint under the stars',
    required: false, enabled: true, displayOrder: 2,
    customerVisible: true, system: true, boundTo: 'hook' },

  { fieldId: 'wf-description', fieldKey: 'description', cardSection: 'curriculum',
    label: 'Short Catchy Description', fieldType: 'long_text',
    placeholder: 'Brief summary shown on grids...',
    required: false, enabled: true, displayOrder: 3,
    customerVisible: true, system: true, boundTo: 'description' },

  { fieldId: 'wf-full-details', fieldKey: 'fullDetails', cardSection: 'curriculum',
    label: 'Full Details curriculum (Rich Text)', fieldType: 'rich_text',
    placeholder: 'Write full specifications of what students will accomplish week by week...',
    required: false, enabled: true, displayOrder: 4,
    customerVisible: true, system: true, boundTo: 'fullDetails' },

  // ---- Logistics & Metadata ----
  { fieldId: 'wf-price', fieldKey: 'price', cardSection: 'logistics', label: 'Price in SAR',
    fieldType: 'number', required: true, enabled: true, displayOrder: 0,
    customerVisible: true, system: true, boundTo: 'price' },

  { fieldId: 'wf-duration', fieldKey: 'duration', cardSection: 'logistics', label: 'Duration',
    fieldType: 'dropdown', required: true, enabled: true, displayOrder: 1,
    options: ['1 Hour', '1.5 Hours', '2 Hours', '2.5 Hours', '3 Hours'],
    customerVisible: true, system: true, boundTo: 'duration' },

  { fieldId: 'wf-age-range', fieldKey: 'ageRange', cardSection: 'logistics', label: 'Age Range',
    fieldType: 'dropdown', required: true, enabled: true, displayOrder: 2,
    options: ['All Ages', '4+ years', '6+ years', '12+ years', '16+ years', 'Adults only'],
    customerVisible: true, system: true, boundTo: 'ageRange' },

  { fieldId: 'wf-skill-level', fieldKey: 'skillLevel', cardSection: 'logistics', label: 'Skill Level',
    fieldType: 'dropdown', required: false, enabled: true, displayOrder: 3,
    options: ['Beginner', 'Intermediate', 'Advanced', 'All Levels'],
    customerVisible: true, system: true, boundTo: 'skillLevel' },

  // Live sources — options always come from the real records.
  { fieldId: 'wf-tutor', fieldKey: 'tutor', cardSection: 'logistics', label: 'Tutor / Artist Specialist',
    fieldType: 'dropdown', required: false, enabled: true, displayOrder: 4,
    customerVisible: true, system: true, boundTo: 'staffId', dataSource: 'staff' },

  { fieldId: 'wf-room', fieldKey: 'room', cardSection: 'logistics', label: 'Studio Room / Table Station',
    fieldType: 'dropdown', required: false, enabled: true, displayOrder: 5,
    customerVisible: false, system: true, boundTo: 'roomId', dataSource: 'studio-resources' },

  { fieldId: 'wf-materials', fieldKey: 'materials', cardSection: 'logistics',
    label: 'Materials Included (Press Enter key)', fieldType: 'tags',
    placeholder: 'Add a material and press Enter...',
    required: false, enabled: true, displayOrder: 6,
    customerVisible: true, system: true, boundTo: 'materials' }
];

export const WORKSHOP_FIELD_TYPES: Array<{ value: WorkshopFieldType; label: string }> = [
  { value: 'short_text', label: 'Short text' },
  { value: 'long_text', label: 'Long text / textarea' },
  { value: 'rich_text', label: 'Rich text' },
  { value: 'number', label: 'Number' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'multi_select', label: 'Multi-select' },
  { value: 'tags', label: 'Tags' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'date', label: 'Date' },
  { value: 'time', label: 'Time' }
];

/**
 * Layout is derived from the field type rather than configured: text areas,
 * rich text and multi-value inputs need the full row, everything else pairs up.
 */
export function fieldSpansFullRow(type: WorkshopFieldType): boolean {
  return type === 'long_text' || type === 'rich_text' || type === 'tags' || type === 'multi_select';
}

/**
 * Reshapes a stored value for the field's current type. The type of any field
 * can be changed at any time, so a value saved as a list may now be edited as
 * text (and the other way round) — this keeps the existing value usable
 * instead of dropping it.
 */
export function coerceFieldValue(value: any, type: WorkshopFieldType): any {
  const wantsList = type === 'tags' || type === 'multi_select';

  if (wantsList) {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null || value === '') return [];
    return String(value).split(',').map(v => v.trim()).filter(Boolean);
  }

  if (Array.isArray(value)) return value.join(', ');
  if (type === 'checkbox') return !!value;
  return value;
}

/** Field types that carry an editable option list. */
export function fieldTypeUsesOptions(type: WorkshopFieldType): boolean {
  return type === 'dropdown' || type === 'multi_select';
}

/** Enabled fields for a card, in configured order. */
export function fieldsForCard(
  fields: WorkshopFieldConfig[],
  card: WorkshopCardSection,
  includeDisabled = false
): WorkshopFieldConfig[] {
  return fields
    .filter(f => f.cardSection === card && (includeDisabled || f.enabled))
    .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
}

export interface StudioTableConfig {
  id: string;
  /** Display number shown in the capacity table, e.g. 1 for "Table 1". */
  number: number;
  name: string; // e.g. "Table 1"
  seats: number;
  status: 'Active' | 'Inactive' | 'Maintenance';
}

export interface CapacitySettingsConfig {
  totalTables: number;
  totalSeats: number;
  defaultSeatsPerTable: number;
  maxGroupSize: number;
  oneGroupPerTable: boolean;
  tables: StudioTableConfig[];
}

/**
 * Customer-facing birthday terms. Stored in settings so staff can edit them;
 * {deposit} and {cancellationDays} are filled in at render time so the wording
 * follows the configured values instead of being hardcoded.
 */
export interface BirthdayTermsConfig {
  /** Bumped whenever staff change the wording; saved with each acceptance. */
  version: string;
  title: string;
  /** Lines shown before the numbered supplies list. */
  leadingItems: string[];
  suppliesIntro: string;
  supplies: string[];
  /** Lines shown after the supplies list. */
  trailingItems: string[];
  /**
   * Optional Arabic twins of the five fields above. Together they are ONE standalone
   * Arabic document, not line-by-line translations, so the lists need not match the
   * English ones in length or order. Shown only when the Arabic body (leadingItemsAr or
   * suppliesAr) is non-empty and the visitor reads Arabic; the whole set switches
   * together, never mixed with English. Covered by the same `version` stamp.
   */
  titleAr?: string;
  leadingItemsAr?: string[];
  suppliesIntroAr?: string;
  suppliesAr?: string[];
  trailingItemsAr?: string[];
  updatedAt?: string;
}

export const DEFAULT_BIRTHDAY_TERMS: BirthdayTermsConfig = {
  version: '2026-08-1',
  title: 'Event Terms and Guidelines',
  leadingItems: [
    'Please adhere to the scheduled time of the event.'
  ],
  suppliesIntro: 'All event supplies will be provided by Arty Café, including:',
  supplies: [
    'Celebration cake',
    'Balloons',
    'Beverages',
    'Music'
  ],
  trailingItems: [
    'A deposit of {deposit} SAR is required to confirm the booking.',
    'Changes or cancellations must be made at least {cancellationDays} days before the scheduled event to receive a refund of the deposit.',
    'Outside food and beverages are strictly prohibited.'
  ]
};

/** Substitutes the dynamic values into a terms line. */
export function renderTermsLine(
  line: string,
  values: { deposit: number; cancellationDays: number }
): string {
  return line
    .replace(/\{deposit\}/g, String(values.deposit))
    .replace(/\{cancellationDays\}/g, String(values.cancellationDays));
}

export interface EventsSettingsConfig {
  minimumBirthdayBookingDays?: number;
  minBirthdayNoticeDays?: number;
  maxBirthdayGuests?: number;
  maxGuestsPerEvent?: number;
  depositPercentage?: number;
  cancellationNoticeDays?: number;
  /** Editable birthday terms shown before final submission. */
  birthdayTerms?: BirthdayTermsConfig;
}

/**
 * A configurable option list used by the Workshop form.
 *
 * Only genuinely static option lists live here. Tutors come from Staff
 * Management and studio rooms/tables from Settings → Capacity; those are live
 * records and are never duplicated as manual options.
 */
export type WorkshopOptionType =
  | 'category'
  | 'workshopType'
  | 'material'
  | 'skillLevel'
  | 'ageGroup'
  | 'durationPreset'
  | 'pricingType'
  /** @deprecated Rooms now come from Settings → Capacity. */
  | 'room';

export interface WorkshopOption {
  id: string;
  type: WorkshopOptionType;
  value: string;
  order: number;
  /** Disabled options stay valid on saved workshops but cannot be chosen. */
  enabled?: boolean;
}

/** Which card on the Workshop form each list belongs to. */
export interface WorkshopOptionList {
  type: WorkshopOptionType;
  label: string;
  card: 'curriculum' | 'logistics';
  hint?: string;
}

/**
 * Mirrors the two Workshop page cards exactly.
 *
 * Curriculum Basics holds Workshop Title, Category, One-Line Hook, Short
 * Description and Full Details — only Category is a selectable list, the rest
 * are free text and are deliberately not turned into option lists.
 *
 * Logistics & Metadata holds Price, Duration, Age Range, Skill Level, Tutor,
 * Studio Room / Table Station and Materials Included. Price is a number; Tutor
 * and Studio Room are live records configured at their own source.
 */
export const WORKSHOP_OPTION_LISTS: WorkshopOptionList[] = [
  { type: 'category', label: 'Categories', card: 'curriculum', hint: 'The Category dropdown on the Workshop Curriculum basics card.' },
  { type: 'durationPreset', label: 'Duration Presets', card: 'logistics', hint: 'The Duration dropdown on Logistics & Metadata.' },
  { type: 'ageGroup', label: 'Age Groups', card: 'logistics', hint: 'The Age Range dropdown on Logistics & Metadata.' },
  { type: 'skillLevel', label: 'Skill Levels', card: 'logistics', hint: 'The Skill Level dropdown on Logistics & Metadata.' },
  { type: 'material', label: 'Materials Included', card: 'logistics', hint: 'Suggestions for the Materials Included tag input.' }
];

/** Option lists seeded so the Workshop form always has something to offer. */
export const DEFAULT_WORKSHOP_OPTIONS: Array<{ type: WorkshopOptionType; values: string[] }> = [
  { type: 'skillLevel', values: ['Beginner', 'Intermediate', 'Advanced', 'All Levels'] },
  { type: 'ageGroup', values: ['All Ages', '4+ years', '6+ years', '12+ years', '16+ years', 'Adults only'] },
  { type: 'durationPreset', values: ['1 Hour', '1.5 Hours', '2 Hours', '2.5 Hours', '3 Hours'] }
];

export function isWorkshopOptionEnabled(option: WorkshopOption): boolean {
  return option.enabled !== false;
}

export interface EventOption {
  id: string;
  type: 'eventCategory' | 'eventType' | 'location' | 'host';
  value: string;
  order: number;
}

export interface AppSetting {
  id: string;
  value: any;
}

export interface LoggingConsoleField {
  id: string;
  key: string;
  label: string;
  type: 'short_text' | 'long_text' | 'number' | 'date' | 'dropdown' | 'multi_select' | 'customer' | 'staff' | 'workshop' | 'status' | 'piece_code' | 'image';
  placeholder?: string;
  required: boolean;
  enabled: boolean;
  order: number;
  options?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export const DEFAULT_LOGGING_FIELDS: LoggingConsoleField[] = [
  {
    id: 'f_customer',
    key: 'customer',
    label: '1. Customer / Ceramic Owner',
    type: 'customer',
    placeholder: 'Type customer name to search existing...',
    required: true,
    enabled: true,
    order: 1
  },
  {
    id: 'f_workshop',
    key: 'workshop',
    label: '2. Workshop / Class Origin (Optional)',
    type: 'workshop',
    placeholder: 'Select workshop or freestyle',
    required: false,
    enabled: true,
    order: 2
  },
  {
    id: 'f_piece_type',
    key: 'pieceType',
    label: '3. Pottery Piece Type',
    type: 'dropdown',
    placeholder: 'Select piece type',
    required: false,
    enabled: true,
    order: 3,
    options: ['Mug', 'Mug with handle', 'Bowl', 'Plate', 'Vase', 'Sculpture', 'Ash tray', 'Other']
  },
  {
    id: 'f_glazing_notes',
    key: 'additionalDescriptionGlazingNotes',
    label: '4. Additional Description / Glazing Notes',
    type: 'long_text',
    placeholder: 'Add optional piece details, glazing colour requests, finishing instructions, or other notes…',
    required: false,
    enabled: true,
    order: 4
  },
  {
    id: 'f_piece_code',
    key: 'pieceCode',
    label: '5. Piece Code',
    type: 'piece_code',
    placeholder: 'e.g. AC-8802',
    required: true,
    enabled: true,
    order: 5
  },
  {
    id: 'f_image',
    key: 'image',
    label: '6. Photo Capture & Preview',
    type: 'image',
    placeholder: '',
    required: false,
    enabled: true,
    order: 6
  },
  {
    id: 'f_name',
    key: 'name',
    label: '7. Piece Label / Title',
    type: 'short_text',
    placeholder: 'E.g. Turquoise Ribbed Tea Mug',
    required: true,
    enabled: true,
    order: 7
  },
  {
    id: 'f_date_created',
    key: 'dateCreated',
    label: '8. Creation Date',
    type: 'date',
    placeholder: '',
    required: true,
    enabled: true,
    order: 8
  },
  {
    id: 'f_assigned_staff',
    key: 'assignedStaff',
    label: '9. Assigned Staff Member',
    type: 'staff',
    placeholder: 'Select staff member',
    required: false,
    enabled: true,
    order: 9
  },
  {
    id: 'f_status',
    key: 'status',
    label: '10. Initial Lifecycle Status',
    type: 'status',
    placeholder: '',
    required: true,
    enabled: true,
    order: 10
  },
  {
    id: 'f_storage_location',
    key: 'storageLocation',
    label: '11. Storage Location / Shelf',
    type: 'short_text',
    placeholder: 'e.g. Shelf A-1',
    required: false,
    enabled: true,
    order: 11
  },
  {
    id: 'f_expected_ready_date',
    key: 'expectedReadyDate',
    label: '12. Expected Ready Date',
    type: 'date',
    placeholder: '',
    required: false,
    enabled: true,
    order: 12
  }
];

export interface AppEvent {
  id: string;
  title: string;
  category: string;
  eventType: string;
  shortDescription: string;
  fullDetails: string;
  image: string;
  date: string;
  startTime: string;
  duration: string;
  capacity: number;
  spotsLeft: number;
  price: number;
  host: string;
  staffId?: string;
  location: string;
  roomId?: string;
  tableId?: string;
  ageRequirement: string;
  skillLevel: string;
  status: 'Draft' | 'Published' | 'Fully Booked' | 'Cancelled' | 'Completed' | 'Archived';
}

export const INITIAL_EVENTS: AppEvent[] = [
  {
    id: 'evt-1',
    title: 'Jeddah Sunset Clay & Jazz Night',
    category: 'Socials',
    eventType: 'Clay & Jazz',
    shortDescription: 'Unique sunset clay sculpting and live acoustic jazz performance.',
    fullDetails: 'Join us for an unforgettable evening at Arty Café Jeddah! Mold clay with professional ceramicists while enjoying smooth sunset jazz vibes. No experience required. Each ticket includes terracotta clay, glazing service, and one hot café beverage.',
    image: 'https://images.unsplash.com/photo-1513151233558-d860c5398176?auto=format&fit=crop&w=800&q=80',
    date: getRelativeRiyadhDateStr(0),
    startTime: '07:30 PM',
    duration: '2.5 Hours',
    capacity: 20,
    spotsLeft: 4,
    price: 350,
    host: 'Studio Manager Lina',
    location: 'The Terrace',
    ageRequirement: '16+ years',
    skillLevel: 'All Levels',
    status: 'Published'
  },
  {
    id: 'evt-2',
    title: 'Coffee Mug Glazing Masterclass',
    category: 'Masterclass',
    eventType: 'Glazing Party',
    shortDescription: 'Master the chemistry of dipping, brushing, and splashing professional ceramic glazes.',
    fullDetails: 'Take your hand-built or wheel-thrown mugs to the next level. In this deep-dive glazing session, you will learn the secrets of wax resist, glaze layering, bubble glazing, and gradient finishes. Includes 2 practice bisque-fired cups and professional-grade glazes.',
    image: 'https://images.unsplash.com/photo-1595435934249-5df7ed86e1c0?auto=format&fit=crop&w=800&q=80',
    date: getRelativeRiyadhDateStr(4),
    startTime: '04:00 PM',
    duration: '2.5 Hours',
    capacity: 15,
    spotsLeft: 5,
    price: 280,
    host: 'Guest Artist Faisal',
    location: 'Studio A',
    ageRequirement: '12+ years',
    skillLevel: 'Intermediate',
    status: 'Published'
  }
];


// ==========================================================
// PRE-PAYMENT BOOKING POP-UP
// Plain-text content only. Admins write normal text; nothing
// here is ever interpreted as HTML, so there is no way to
// inject markup or script through these settings.
// ==========================================================

export interface PrePaymentPopupConfig {
  enabled: boolean;
  /** Heading shown at the top of the pop-up. */
  title: string;
  /** Main message. Plain text; blank lines separate paragraphs. */
  message: string;
  /** Optional short instructions, one per line, shown as a list. */
  instructions: string[];
  /** Label on the confirm button. */
  buttonLabel: string;
  requiredCheckbox: boolean;
  checkboxLabel: string;
}

export const DEFAULT_PREPAYMENT_POPUP: PrePaymentPopupConfig = {
  enabled: true,
  title: 'Important Studio Safety & Timeline Instructions',
  message: 'Please note the following studio rules before proceeding to payment.',
  instructions: [
    'Clay Processing Time: All pottery created in the studio takes 10 to 14 days to completely air dry, undergo bisque-firing, be hand-glazed, and fired a second time.',
    'Live Tracker: Once booked, your piece will appear in your "My Pieces" collection tracker where you can track its lifecycle stages.',
    'Safety Attire: We recommend wearing clothes you do not mind getting a little clay on (although aprons are provided!).',
    'Storage Window: Your finished pieces will be held at our collection shelves for up to 30 days post-firing.'
  ],
  buttonLabel: 'Continue to Payment',
  requiredCheckbox: true,
  checkboxLabel: 'I confirm I have read these safety rules and understand the 10-14 day firing timeline.'
};

/** Turns a fragment of the old HTML body into readable plain text. */
function htmlFragmentToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Reads the stored pop-up setting into the plain-text shape, migrating the
 * legacy HTML `body` where one is present: list items become instructions and
 * the remaining prose becomes the message. Runs on every read, so an older
 * saved record needs no separate upgrade step.
 */
export function migratePrePaymentPopup(raw: any): PrePaymentPopupConfig {
  const stored = raw || {};

  let message: string = typeof stored.message === 'string' ? stored.message : '';
  let instructions: string[] = Array.isArray(stored.instructions)
    ? stored.instructions.filter((line: any) => typeof line === 'string' && line.trim())
    : [];

  // Legacy records carry an HTML body and no plain-text fields yet.
  const legacyBody: string = typeof stored.body === 'string' ? stored.body : '';
  if (legacyBody.trim() && !message.trim() && instructions.length === 0) {
    const items = [...legacyBody.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
      .map(m => htmlFragmentToText(m[1]))
      .filter(Boolean);

    const prose = htmlFragmentToText(legacyBody.replace(/<ul[\s\S]*?<\/ul>/gi, '')
                                              .replace(/<ol[\s\S]*?<\/ol>/gi, ''));

    instructions = items;
    message = prose || (items.length ? '' : htmlFragmentToText(legacyBody));
  }

  return {
    enabled: stored.enabled !== false,
    title: typeof stored.title === 'string' ? stored.title : DEFAULT_PREPAYMENT_POPUP.title,
    message: message || (legacyBody.trim() ? '' : DEFAULT_PREPAYMENT_POPUP.message),
    instructions,
    buttonLabel: typeof stored.buttonLabel === 'string' && stored.buttonLabel.trim()
      ? stored.buttonLabel
      : DEFAULT_PREPAYMENT_POPUP.buttonLabel,
    requiredCheckbox: stored.requiredCheckbox !== false,
    checkboxLabel: typeof stored.checkboxLabel === 'string'
      ? stored.checkboxLabel
      : DEFAULT_PREPAYMENT_POPUP.checkboxLabel
  };
}

/** Splits the message into paragraphs for rendering as text nodes. */
export function popupParagraphs(message: string): string[] {
  return (message || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
}
