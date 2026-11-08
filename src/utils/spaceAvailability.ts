/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Studio room and table availability, built on the same shared records and the
 * same overlap rule as staff scheduling:
 *
 *   proposedStart < existingEnd AND proposedEnd > existingStart
 *
 * Spaces are identified by stable ids (room option id / studio table id); labels
 * are only ever used to match rows saved before those ids existed.
 */

import {
  CapacitySettingsConfig, StudioResource, WorkshopSessionRecord, Workshop, AppEvent,
  QueueItem
} from '../types';
import { normalizeDateString, timeToMinutes, getEndTimeMinutes, minutesToTimeString, rangesOverlap } from './timeUtils';

export type SpaceKind = 'room' | 'table';
export type SpaceStatus = 'Active' | 'Inactive' | 'Maintenance';

export interface StudioSpace {
  id: string;
  name: string;
  kind: SpaceKind;
  status: SpaceStatus;
  seats?: number;
}

export interface SpaceSources {
  workshopSessions?: WorkshopSessionRecord[];
  workshops?: Workshop[];
  events?: AppEvent[];
  queue?: QueueItem[];
}

export interface SpaceOccupancy {
  spaceId: string;
  sourceType: 'workshop-session' | 'event' | 'queue';
  sourceId: string;
  workshopId?: string;
  title: string;
  date: string;
  startMinutes: number;
  endMinutes: number;
  startTime: string;
  endTime: string;
}

export interface SpaceExclusion {
  sessionIds?: string[];
  workshopId?: string;
  eventIds?: string[];
}

export interface SpaceAvailabilityResult {
  isAvailable: boolean;
  status: 'Available' | 'Busy' | 'Inactive' | 'Under maintenance';
  reason?: string;
  conflictDetails?: string;
  conflict?: SpaceOccupancy;
  /** Ready-to-render label, e.g. "Table 3 — Busy: Pottery Workshop, 5:00 PM–7:00 PM". */
  label: string;
}

const INACTIVE_SESSION_STATUSES = ['Cancelled', 'Unavailable', 'Archived'];
const INACTIVE_EVENT_STATUSES = ['Cancelled', 'Archived', 'Completed'];
const INACTIVE_QUEUE_STATUSES = ['Cancelled', 'Completed'];

/**
 * Every bookable studio space, from the shared Studio Rooms & Table Stations
 * records managed in Settings → Capacity.
 */
export function getStudioSpaces(
  resources: StudioResource[] = [],
  _legacyCapacityConfig?: CapacitySettingsConfig
): StudioSpace[] {
  return [...resources]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(resource => ({
      id: resource.id,
      name: resource.name,
      kind: resource.type === 'Table Station' ? ('table' as const) : ('room' as const),
      status: (resource.status || 'Active') as SpaceStatus,
      seats: resource.seats
    }));
}

/** Only Active spaces may take a new assignment. */
export function isAssignableSpace(space: StudioSpace): boolean {
  return space.status === 'Active';
}

/** Matches a record's space to a known space, by id first and label second. */
function matchesSpace(space: StudioSpace, id?: string | null, label?: string | null): boolean {
  if (id && String(id) === space.id) return true;

  const name = String(label || '').trim().toLowerCase();
  if (!name) return false;

  // A resource may have an empty or missing display name; only the id is required.
  const spaceName = String(space.name || '').trim().toLowerCase();
  if (!spaceName) return false;

  return name === spaceName;
}

/**
 * Everything occupying a given space, from workshop sessions, events/birthdays
 * and active studio appointments.
 */
export function getSpaceOccupancy(
  space: StudioSpace,
  sources: SpaceSources,
  exclude?: SpaceExclusion
): SpaceOccupancy[] {
  const { workshopSessions = [], workshops = [], events = [], queue = [] } = sources;
  const workshopById = new Map(workshops.map(w => [String(w.id), w]));
  const out: SpaceOccupancy[] = [];

  workshopSessions.forEach(sess => {
    if (INACTIVE_SESSION_STATUSES.includes(sess.status || 'Published')) return;
    if (exclude?.sessionIds?.some(id => String(id) === String(sess.id))) return;
    if (exclude?.workshopId && String(sess.workshopId) === String(exclude.workshopId)) return;
    if (!sess.startTime) return;

    const parent = sess.workshopId ? workshopById.get(String(sess.workshopId)) : undefined;

    const occupies =
      (space.kind === 'room' && matchesSpace(space, sess.roomId || parent?.roomId, sess.room || parent?.room)) ||
      (space.kind === 'table' && matchesSpace(space, sess.tableId || parent?.tableId, sess.tableName));
    if (!occupies) return;

    const startMinutes = timeToMinutes(sess.startTime);
    const endMinutes = sess.endTime
      ? timeToMinutes(sess.endTime)
      : getEndTimeMinutes(sess.startTime, sess.duration || parent?.duration);

    out.push({
      spaceId: space.id,
      sourceType: 'workshop-session',
      sourceId: String(sess.id),
      workshopId: sess.workshopId ? String(sess.workshopId) : undefined,
      title: parent?.title || 'Workshop Session',
      date: normalizeDateString(sess.date),
      startMinutes,
      endMinutes,
      startTime: sess.startTime,
      endTime: sess.endTime || minutesToTimeString(endMinutes)
    });
  });

  events.forEach(evt => {
    if (INACTIVE_EVENT_STATUSES.includes(evt.status || 'Published')) return;
    if (exclude?.eventIds?.some(id => String(id) === String(evt.id))) return;
    if (!evt.startTime) return;
    if (!matchesSpace(space, space.kind === 'room' ? evt.roomId : evt.tableId, evt.location)) return;

    const startMinutes = timeToMinutes(evt.startTime);
    const endMinutes = getEndTimeMinutes(evt.startTime, evt.duration);

    out.push({
      spaceId: space.id,
      sourceType: 'event',
      sourceId: String(evt.id),
      title: evt.title,
      date: normalizeDateString(evt.date),
      startMinutes,
      endMinutes,
      startTime: evt.startTime,
      endTime: minutesToTimeString(endMinutes)
    });
  });

  queue.forEach(item => {
    if (INACTIVE_QUEUE_STATUSES.includes(item.status || 'Waiting')) return;
    if (!item.checkInTime) return;
    // Queue entries only hold a table when they were seated at one.
    if (space.kind !== 'table') return;
    if (!matchesSpace(space, (item as any).tableId, (item as any).tableName)) return;

    const startMinutes = timeToMinutes(item.checkInTime);
    const endMinutes = startMinutes + Math.round((item.hours || 1) * 60);

    out.push({
      spaceId: space.id,
      sourceType: 'queue',
      sourceId: String(item.id),
      title: item.activity || 'Studio Appointment',
      date: normalizeDateString(item.date),
      startMinutes,
      endMinutes,
      startTime: item.checkInTime,
      endTime: minutesToTimeString(endMinutes)
    });
  });

  return out;
}

export interface SpaceCheckInput {
  space: StudioSpace;
  date: string;
  startTime: string;
  endTime?: string;
  duration?: string;
  sources: SpaceSources;
  exclude?: SpaceExclusion;
}

/** Is this room or table free for the proposed date and time range? */
export function checkSpaceAvailability(input: SpaceCheckInput): SpaceAvailabilityResult {
  const { space } = input;

  if (space.status === 'Inactive') {
    return {
      isAvailable: false,
      status: 'Inactive',
      reason: `${space.name} is inactive`,
      label: `${space.name} — Inactive`
    };
  }

  if (space.status === 'Maintenance') {
    return {
      isAvailable: false,
      status: 'Under maintenance',
      reason: `${space.name} is under maintenance`,
      label: `${space.name} — Under maintenance`
    };
  }

  const targetDate = normalizeDateString(input.date);
  const proposedStart = timeToMinutes(input.startTime);
  const proposedEnd = input.endTime
    ? timeToMinutes(input.endTime)
    : getEndTimeMinutes(input.startTime, input.duration);

  const occupancy = getSpaceOccupancy(space, input.sources, input.exclude);

  for (const booked of occupancy) {
    if (booked.date !== targetDate) continue;
    if (!rangesOverlap(proposedStart, proposedEnd, booked.startMinutes, booked.endMinutes)) continue;

    const window = `${minutesToTimeString(booked.startMinutes)}–${minutesToTimeString(booked.endMinutes)}`;
    return {
      isAvailable: false,
      status: 'Busy',
      reason: `${space.name} is already used by ${booked.title} on ${booked.date} from ${window}`,
      conflictDetails: `${booked.title}, ${window}`,
      conflict: booked,
      label: `${space.name} — Busy: ${booked.title}, ${window}`
    };
  }

  return { isAvailable: true, status: 'Available', label: `${space.name} — Available` };
}

/** Checks a space across many date/time slots; returns the first clash found. */
export function findSpaceConflictAcrossSlots(
  space: StudioSpace,
  slots: Array<{ date: string; startTime: string; endTime?: string; duration?: string }>,
  sources: SpaceSources,
  exclude?: SpaceExclusion
): SpaceAvailabilityResult | null {
  if (space.status !== 'Active') {
    return checkSpaceAvailability({
      space, date: slots[0]?.date || '', startTime: slots[0]?.startTime || '', sources, exclude
    });
  }

  for (const slot of slots) {
    const result = checkSpaceAvailability({ space, ...slot, sources, exclude });
    if (!result.isAvailable) return result;
  }
  return null;
}
