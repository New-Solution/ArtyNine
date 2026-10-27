/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The one place column names are translated.
 *
 * Postgres columns are snake_case; the application models are camelCase and
 * must not change, because every component reads them through useApp(). Rather
 * than a hand-written map per table, the conversion is mechanical — the schema
 * in supabase/migrations/0001_init.sql was written so that every column is the
 * snake_case form of its model field.
 *
 * Two shapes are assembled rather than converted, because they no longer map
 * one-to-one onto a row:
 *   - a piece's `history` comes from the piece_history table
 *   - a workshop's `sessions` comes from the workshop_sessions table
 */

/** snake_case -> camelCase, leaving already-camel keys alone. */
export function toCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/** camelCase -> snake_case. */
export function toSnake(key: string): string {
  return key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
}

/** A database row as the app's model. */
export function rowToModel<T = any>(row: Record<string, any> | null | undefined): T {
  if (!row) return row as T;
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(row)) out[toCamel(key)] = value;
  return out as T;
}

export function rowsToModels<T = any>(rows: Array<Record<string, any>> | null | undefined): T[] {
  return (rows || []).map(r => rowToModel<T>(r));
}

/**
 * A model as a database row.
 *
 * `undefined` values are dropped so a partial update only touches the columns
 * it names. `null` is kept: it is how a field is deliberately cleared.
 */
export function modelToRow(model: Record<string, any>, allowed?: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(model || {})) {
    if (value === undefined) continue;
    const column = toSnake(key);
    if (allowed && !allowed.includes(column)) continue;
    out[column] = value;
  }
  return out;
}

/**
 * Columns that exist on each table, so a model carrying extra client-side
 * fields cannot produce an "column does not exist" error. Mirrors
 * 0001_init.sql, plus 0035 for the *_ar columns and 0045 for the stage-id
 * columns.
 */
export const TABLE_COLUMNS: Record<string, string[]> = {
  customers: [
    'id', 'user_id', 'name', 'email', 'phone', 'display_phone', 'normalized_phone',
    'source', 'status', 'notes', 'has_account', 'total_spent', 'created_at', 'updated_at'
  ],
  staff: [
    'id', 'user_id', 'name', 'profile_image', 'country_code', 'phone', 'normalized_phone',
    'email', 'position', 'skills', 'status', 'weekly_schedule', 'break_periods', 'time_off',
    'notes', 'can_assign_workshops', 'can_assign_pieces', 'role', 'permissions',
    'has_console_access', 'password_is_temporary', 'last_login_at', 'created_at', 'updated_at'
  ],
  workshops: [
    'id', 'title', 'slug', 'category', 'hook', 'description', 'full_details', 'duration',
    'age_range', 'price', 'pricing_type', 'capacity', 'image',
    'additional_images', 'instructor', 'staff_id', 'room', 'room_id', 'table_id', 'materials', 'materials_ar',
    'what_we_provide', 'instructions', 'cancellation_policy', 'skill_level', 'status',
    'featured', 'recurring_schedules', 'session_exceptions', 'custom_fields',
    'title_ar', 'hook_ar', 'description_ar', 'full_details_ar',
    'created_at', 'updated_at'
  ],
  workshop_sessions: [
    'id', 'workshop_id', 'date', 'start_time', 'end_time', 'duration', 'instructor',
    'staff_id', 'room_id', 'room', 'table_id', 'table_name', 'rule_id', 'capacity',
    'status', 'created_at', 'updated_at'
  ],
  bookings: [
    'id', 'customer_id', 'customer_name', 'customer_email', 'customer_phone', 'workshop_id',
    'session_id', 'workshop_title', 'date', 'time', 'participants', 'total_price', 'source',
    'status', 'payment_status', 'notes', 'staff_id', 'staff_name',
    'birthday_details', 'timeline', 'created_at', 'updated_at'
  ],
  queue: [
    'id', 'queue_number', 'booking_id', 'customer_id', 'name', 'phone', 'activity', 'participants',
    'check_in_time', 'elapsed_minutes', 'staff_avatar', 'staff_name', 'staff_id', 'status',
    'source', 'type', 'hours', 'workshop_type', 'date', 'seated_time', 'workshop_id',
    'session_id', 'session_start_time', 'session_end_time', 'session_duration',
    'session_capacity', 'returned_from_queue_id', 'extended_by_queue_id', 'history',
    'table_ids', 'created_at', 'updated_at'
  ],
  pieces: [
    'id', 'piece_code', 'customer_id', 'booking_id', 'workshop_id', 'name', 'workshop_name', 'customer_name',
    'customer_phone', 'date_created', 'image', 'status', 'days_elapsed', 'assigned_staff',
    'damage_note', 'storage_location', 'notes', 'additional_description_glazing_notes',
    'expected_completion', 'expected_ready_date', 'collection_date', 'last_notification_date',
    'stage_id', 'created_at', 'updated_at'
  ],
  piece_history: ['id', 'piece_id', 'status', 'stage_id', 'timestamp', 'riyadh_time', 'user', 'reason', 'created_at'],
  categories: ['id', 'name', 'name_ar', 'created_at'],
  notifications: [
    'id', 'type', 'customer_id', 'customer_phone', 'title', 'message', 'piece_id',
    'piece_name', 'new_status', 'performed_by', 'timestamp', 'is_read', 'highlighted'
  ],
  pipeline_stages: [
    'id', 'name', 'color', 'order', 'visible_to_customer', 'customer_label', 'enabled', 'notify_customer',
    'system_key', 'name_ar', 'customer_label_ar'
  ],
  workshop_options: ['id', 'type', 'value', 'order', 'enabled'],
  event_options: ['id', 'type', 'value', 'order'],
  events: [
    'id', 'title', 'category', 'event_type', 'short_description', 'full_details', 'image',
    'date', 'start_time', 'duration', 'capacity', 'spots_left', 'price', 'host', 'staff_id',
    'location', 'room_id', 'table_id', 'age_requirement', 'skill_level', 'status',
    'created_at', 'updated_at'
  ],
  app_settings: ['id', 'value', 'updated_at'],
  birthday_packages: [
    'id', 'name', 'image', 'short_description', 'full_description', 'price', 'pricing_type',
    'pricing_label', 'duration', 'min_guests', 'max_guests', 'age_information',
    'included_items', 'activity_choices', 'additional_info', 'cake_description', 'cake_sizes',
    'trainer_info', 'delivery_info', 'available_days', 'available_times', 'terms',
    'customer_notes', 'deposit_amount', 'status', 'display_order',
    'name_ar', 'short_description_ar', 'full_description_ar',
    'pricing_label_ar', 'duration_ar', 'age_information_ar', 'cake_description_ar',
    'trainer_info_ar', 'delivery_info_ar', 'customer_notes_ar', 'terms_ar',
    'included_items_ar', 'activity_choices_ar', 'additional_info_ar',
    'created_at', 'updated_at'
  ],
  studio_resources: [
    'id', 'name', 'type', 'seats', 'location', 'notes', 'status', 'order', 'created_at', 'updated_at'
  ]
};

/** A model narrowed to the columns its table actually has. */
export function toRow(table: string, model: Record<string, any>): Record<string, any> {
  return modelToRow(model, TABLE_COLUMNS[table]);
}
