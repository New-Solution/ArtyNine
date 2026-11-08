/**
 * Utility for generating workshop sessions from monthly recurring schedule rules.
 * Respects Asia/Riyadh timezone and avoids duplicate sessions.
 */

import { Workshop, WorkshopSessionRecord } from '../types';
import { getRiyadhNow, parseBookingDateTimeToRiyadhDate } from './dateUtils';
import { WEEKDAY_NAMES } from './calendarConfig';

// Shared English Gregorian weekday names.
const DAY_NAMES = WEEKDAY_NAMES;

/**
 * What a generation run actually did.
 *
 * A run that adds nothing has two completely different meanings, and collapsing
 * them into one message sent staff hunting for a broken rule when the rules
 * were fine: either the rules produced slots and every one of them was already
 * on the calendar (nothing is wrong — the dedup did its job), or the rules
 * produced no slots at all (that one really is worth checking). The counters
 * below are what lets a caller tell those apart, and report a partial run
 * honestly — "3 added, 2 already existed" rather than just the 3.
 */
export interface SessionGenerationResult {
  /** The new sessions. Empty is not an error. */
  sessions: WorkshopSessionRecord[];
  /** Slots skipped because the session already exists. */
  skippedExisting: number;
  /** Slots skipped because their start time has already passed. */
  skippedPast: number;
  /** Slots skipped because another rule in the same run already covered them. */
  skippedOverlappingRule: number;
  /** Every slot the rules produced for this month, before any skipping. */
  slotsConsidered: number;
}

/**
 * Generate sessions for a specific workshop and given month/year based on its
 * recurring rules, reporting what was skipped and why.
 */
export function generateSessionsForMonthDetailed(
  workshop: Workshop,
  year: number,
  month: number, // 1-12
  existingSessions: WorkshopSessionRecord[]
): SessionGenerationResult {
  const generated: WorkshopSessionRecord[] = [];
  const result: SessionGenerationResult = {
    sessions: generated,
    skippedExisting: 0,
    skippedPast: 0,
    skippedOverlappingRule: 0,
    slotsConsidered: 0
  };

  if (!workshop.recurringSchedules || workshop.recurringSchedules.length === 0) {
    return result;
  }

  const daysInMonth = new Date(year, month, 0).getDate();

  for (let day = 1; day <= daysInMonth; day++) {
    const monthStr = month < 10 ? `0${month}` : `${month}`;
    const dayStr = day < 10 ? `0${day}` : `${day}`;
    const dateStr = `${year}-${monthStr}-${dayStr}`;

    // Get day of week name (0 = Sunday, 1 = Monday, etc.)
    const dateObj = new Date(year, month - 1, day);
    const dayName = DAY_NAMES[dateObj.getDay()];

    // Check each active recurring schedule rule
    workshop.recurringSchedules.forEach(rule => {
      if (rule.status !== 'Active') return;
      if (!rule.daysOfWeek.includes(dayName)) return;

      // Check effective start date and end date
      if (rule.effectiveStartDate && dateStr < rule.effectiveStartDate) return;
      if (rule.effectiveEndDate && dateStr > rule.effectiveEndDate) return;

      // Check for exceptions on this date
      const exception = workshop.sessionExceptions?.find(e => e.date === dateStr);
      if (exception && (exception.type === 'cancel' || exception.type === 'unavailable')) {
        return; // Skip cancelled or unavailable exception dates
      }

      const startTime = (exception && exception.type === 'modify' && exception.startTime)
        ? exception.startTime
        : rule.startTime;

      const instructor = (exception && exception.type === 'modify' && exception.instructor)
        ? exception.instructor
        : (rule.instructor || workshop.instructor);

      // The staff ID travels with the generated session so the assignment resolves
      // to the same staff record everywhere.
      const staffId = (exception && exception.type === 'modify' && exception.staffId)
        ? exception.staffId
        : (rule.staffId || workshop.staffId);

      const capacity = (exception && exception.type === 'modify' && exception.capacity)
        ? exception.capacity
        : (rule.capacity || workshop.capacity);

      // Studio space follows the rule, falling back to the workshop's own space.
      const roomId = (exception && exception.type === 'modify' && exception.roomId)
        ? exception.roomId
        : (rule.roomId || workshop.roomId);
      const tableId = (exception && exception.type === 'modify' && exception.tableId)
        ? exception.tableId
        : (rule.tableId || workshop.tableId);

      // Deterministic key for duplicate prevention: workshopId + date + startTime
      const normalizedTime = startTime.trim().toUpperCase();
      // A slot whose start has already passed is never generated. Running the
      // generator for the current month used to produce sessions for earlier
      // today, and running it for a month already over produced a whole
      // calendar of them — staff-side clutter that can only ever be deleted
      // by hand.
      let slotStart: Date | null = null;
      try {
        slotStart = parseBookingDateTimeToRiyadhDate(dateStr, startTime);
      } catch {
        slotStart = null;
      }
      // Counted here rather than at the top of the callback: everything above
      // this point is a rule declining to produce a slot at all (wrong weekday,
      // outside its date range, cancelled by an exception), which is not a slot
      // that was considered and skipped.
      result.slotsConsidered++;

      if (slotStart && !Number.isNaN(slotStart.getTime()) && slotStart.getTime() <= getRiyadhNow().getTime()) {
        result.skippedPast++;
        return;
      }

      const duplicateInExisting = existingSessions.some(
        s => s.workshopId === workshop.id && s.date === dateStr && s.startTime.trim().toUpperCase() === normalizedTime
      );

      const duplicateInGenerated = generated.some(
        s => s.workshopId === workshop.id && s.date === dateStr && s.startTime.trim().toUpperCase() === normalizedTime
      );

      if (duplicateInExisting) result.skippedExisting++;
      else if (duplicateInGenerated) result.skippedOverlappingRule++;

      if (!duplicateInExisting && !duplicateInGenerated) {
        const cleanTimeKey = startTime.replace(/[^a-zA-Z0-9]/g, '');
        generated.push({
          id: `sess-${workshop.id}-${dateStr}-${cleanTimeKey}`,
          workshopId: workshop.id,
          date: dateStr,
          startTime: startTime,
          endTime: rule.endTime,
          duration: rule.duration || workshop.duration,
          instructor: instructor,
          staffId: staffId,
          roomId: roomId,
          room: rule.room || workshop.room,
          tableId: tableId,
          // Links the session back to the rule that produced it.
          ruleId: rule.id,
          capacity: capacity,
          status: 'Published'
        });
      }
    });
  }

  return result;
}

/**
 * The sessions alone, for callers that do not need the breakdown.
 */
export function generateSessionsForMonth(
  workshop: Workshop,
  year: number,
  month: number, // 1-12
  existingSessions: WorkshopSessionRecord[]
): WorkshopSessionRecord[] {
  return generateSessionsForMonthDetailed(workshop, year, month, existingSessions).sessions;
}

/**
 * Ensures sessions are generated for current month and next N months for all workshops.
 */
export function generateUpcomingRecurringSessions(
  workshops: Workshop[],
  existingSessions: WorkshopSessionRecord[],
  monthsCount: number = 3
): WorkshopSessionRecord[] {
  const now = getRiyadhNow();
  let currentYear = now.getFullYear();
  let currentMonth = now.getMonth() + 1; // 1-12

  const allNewSessions: WorkshopSessionRecord[] = [];
  const combinedExisting = [...existingSessions];

  for (let i = 0; i < monthsCount; i++) {
    let targetYear = currentYear;
    let targetMonth = currentMonth + i;
    while (targetMonth > 12) {
      targetMonth -= 12;
      targetYear += 1;
    }

    workshops.forEach(ws => {
      const monthSessions = generateSessionsForMonth(ws, targetYear, targetMonth, combinedExisting);
      allNewSessions.push(...monthSessions);
      combinedExisting.push(...monthSessions);
    });
  }

  return allNewSessions;
}
