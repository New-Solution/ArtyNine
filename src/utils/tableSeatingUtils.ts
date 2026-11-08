/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * ONE place that computes café table occupancy for the Live Queue.
 *
 * A numbered café table (Settings → Capacity → Table Inventory, `StudioTableConfig`)
 * has a stable id, a display name/number and a seat count. A queue entry (a
 * Without Instructor / self-guided walk-in) can hold zero, one or several
 * tables, stored as `tableIds`. Capacity held by a Waiting or Called entry is
 * RESERVED — it blocks a new assignment but is not a physically seated guest;
 * capacity held by an In Progress entry is OCCUPIED. Completed and Cancelled
 * entries hold nothing, so their tables free up the moment the status
 * changes — no separate release step needed.
 *
 * Every component that shows or edits table assignment (the queue cards, the
 * Add Walk-in modal, the Seating Manager, the header metrics) reads this
 * module rather than recomputing occupancy itself.
 */

import { QueueItem, StudioTableConfig, CapacitySettingsConfig } from '../types';

/** Queue statuses that still hold table capacity. */
const ACTIVE_QUEUE_STATUSES: QueueItem['status'][] = ['Waiting', 'Called', 'In Progress'];

export interface TableOccupant {
  queueId: string;
  name: string;
  participants: number;
  status: QueueItem['status'];
}

export interface TableSeatState {
  id: string;
  number: number;
  name: string;
  seats: number;
  status: StudioTableConfig['status'];
  /** Seats held by Waiting/Called entries — reserved, not yet physically seated. */
  reservedSeats: number;
  /** Seats held by In Progress entries — physically occupied right now. */
  occupiedSeats: number;
  freeSeats: number;
  occupants: TableOccupant[];
}

/** The configured café tables, from Settings → Capacity. Never undefined. */
export function getConfiguredTables(appSettings: Array<{ id: string; value: any }>): StudioTableConfig[] {
  const config = appSettings.find(s => s.id === 'capacitySettings')?.value as CapacitySettingsConfig | undefined;
  return [...(config?.tables || [])].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
}

export interface ComputeTableStatesOptions {
  /**
   * A queue entry whose own current assignment should not count against
   * itself — used while re-assigning or seating an entry that already holds
   * (or is about to keep) one of the tables being evaluated.
   */
  excludeQueueId?: string;
  /** Only today's queue matters for café seating. */
  todayDateStr?: string;
}

/** Live occupancy for every configured table, derived from the queue. */
export function computeTableStates(
  tables: StudioTableConfig[],
  queue: QueueItem[],
  options: ComputeTableStatesOptions = {}
): TableSeatState[] {
  const { excludeQueueId, todayDateStr } = options;

  const relevant = queue.filter(q => {
    if (excludeQueueId && String(q.id) === String(excludeQueueId)) return false;
    if (!ACTIVE_QUEUE_STATUSES.includes(q.status)) return false;
    if (todayDateStr && q.date !== todayDateStr) return false;
    return true;
  });

  return tables.map(table => {
    const occupants = relevant.filter(q => (q.tableIds || []).includes(table.id));

    const reservedSeats = occupants
      .filter(q => q.status !== 'In Progress')
      .reduce((sum, q) => sum + (Number(q.participants) || 0), 0);

    const occupiedSeats = occupants
      .filter(q => q.status === 'In Progress')
      .reduce((sum, q) => sum + (Number(q.participants) || 0), 0);

    const seats = Number(table.seats) || 0;

    return {
      id: table.id,
      number: table.number,
      name: table.name,
      seats,
      status: table.status,
      reservedSeats,
      occupiedSeats,
      freeSeats: Math.max(0, seats - reservedSeats - occupiedSeats),
      occupants: occupants.map(q => ({
        queueId: q.id,
        name: q.name,
        participants: Number(q.participants) || 0,
        status: q.status
      }))
    };
  });
}

/** A table can take a new (or larger) assignment only while Active and has room. */
export function isTableSelectable(table: TableSeatState): boolean {
  return table.status === 'Active' && table.freeSeats > 0;
}

export interface TableSelectionCheck {
  valid: boolean;
  error?: string;
}

/**
 * Validates a proposed set of table ids against a guest count. Callers pass
 * table states already computed with `excludeQueueId` set to the entry being
 * (re)assigned, so an entry keeping one of its own tables is not blocked by
 * its own reservation.
 */
export function validateTableSelection(
  selectedIds: string[],
  participants: number,
  tableStates: TableSeatState[]
): TableSelectionCheck {
  if (selectedIds.length === 0) {
    return { valid: false, error: 'Select at least one table.' };
  }

  let totalFree = 0;
  for (const id of selectedIds) {
    const table = tableStates.find(t => t.id === id);
    if (!table) return { valid: false, error: 'One of the selected tables no longer exists.' };
    if (table.status !== 'Active') return { valid: false, error: `${table.name} is not available.` };
    totalFree += table.freeSeats;
  }

  const guests = Number(participants) || 0;
  if (totalFree < guests) {
    return {
      valid: false,
      error: `Selected table${selectedIds.length > 1 ? 's' : ''} only ${totalFree === 1 ? 'has' : 'have'} ${totalFree} free seat${totalFree === 1 ? '' : 's'} — this group needs ${guests}.`
    };
  }

  return { valid: true };
}

/** Display names for a set of table ids, falling back for a deleted table. */
export function tableNamesFor(tableIds: string[] | undefined, tables: StudioTableConfig[]): string {
  if (!tableIds || tableIds.length === 0) return '';
  return tableIds
    .map(id => tables.find(t => t.id === id)?.name || 'Removed table')
    .join(' + ');
}

/**
 * The studio's seat total: the sum of every configured table's seats.
 *
 * The ONE definition, used by Settings -> Capacity, the Live Queue header and
 * the Table Inventory. There used to be a separately typed "Total Studio
 * Seats" number as well, and the two could disagree on the same page.
 */
export function tableSeatTotal(tables: Array<{ seats?: number | string | null }>): number {
  return tables.reduce((sum, t) => sum + (Number(t.seats) || 0), 0);
}

/** Aggregate counters for the Live Queue header metrics and Table Inventory. */
export function summarizeTableCapacity(tableStates: TableSeatState[]) {
  const totalTables = tableStates.length;
  const totalSeats = tableSeatTotal(tableStates);
  const occupiedSeats = tableStates.reduce((s, t) => s + t.occupiedSeats, 0);
  const reservedSeats = tableStates.reduce((s, t) => s + t.reservedSeats, 0);
  const freeSeats = tableStates.reduce((s, t) => s + t.freeSeats, 0);
  const occupiedTables = tableStates.filter(t => t.occupiedSeats > 0).length;
  const reservedTables = tableStates.filter(t => t.reservedSeats > 0 && t.occupiedSeats === 0).length;
  const availableTables = tableStates.filter(t => isTableSelectable(t)).length;
  return { totalTables, totalSeats, occupiedSeats, reservedSeats, freeSeats, occupiedTables, reservedTables, availableTables };
}
