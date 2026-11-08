/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * provision-staff — audit finding C-3, Chunk 1 (backend foundation only).
 *
 * Establishes staff.user_id under a trusted, server-verified authorization
 * check. This is the ONLY place that relationship is ever written. Nothing
 * about it is reachable from the browser except through this function's own
 * authorization gate — the service-role key used for the privileged Auth
 * Admin API calls and the RLS-bypassing staff/customers reads lives only in
 * this function's Deno runtime, read from Supabase's own function-secret
 * store (SUPABASE_SERVICE_ROLE_KEY is auto-injected into every Edge
 * Function's environment; it is never read from, or written to, any file in
 * this repository).
 *
 * loginStaff() (src/context/AppContext.tsx) is NOT changed by this chunk. It
 * still contains the email-match fallback this function exists to make
 * unnecessary — that removal is a later chunk, once this exists and staff
 * are actually provisioned through it.
 *
 * DO NOT DEPLOY THIS CHUNK. It has been written and locally verified
 * (logic.test.ts) only; deployment is a later, explicit step.
 */

import { createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2.112.2';
import {
  decideProvisioning,
  type AuthLookup,
  type OtherStaffRef,
  type TargetStaffRow
} from './logic.ts';
import type { ProvisionStaffRequest, ProvisionStaffResponse } from './contract.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

/** The unforgeable marker this function stamps into a newly-created Auth user's app_metadata. Never user_metadata — that's editable by the account holder via updateUser(). */
const PROVISIONING_MARKER_KEY = 'arty_provision_staff_id';

const json = (body: ProvisionStaffResponse, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });

const REJECT_STATUS: Record<string, number> = {
  not_found: 404,
  invalid_input: 422,
  inactive_staff: 422,
  duplicate_email: 409,
  linked_identity_mismatch: 409,
  linked_identity_missing: 409,
  identity_belongs_to_other_staff: 409
};

const canonicalEmail = (input?: string | null) => String(input ?? '').trim().toLowerCase();

/**
 * The Admin API has no direct "get user by email" lookup — verified against
 * the installed @supabase/auth-js@2.112.2 type definitions
 * (GoTrueAdminApi.d.ts): listUsers() is the only email-searchable surface,
 * and it is paginated (default 50 per page; Pagination gives
 * `nextPage: number | null`, `lastPage`, `total`). A single unpaginated call
 * — what Chunk 1 shipped — silently misses a match once the Auth user count
 * exceeds one page. This walks every page via `nextPage` until it either
 * finds the email or `nextPage` is null.
 *
 * MAX_PAGES is a defensive cap against unexpected API behavior (e.g. a
 * `nextPage` that never goes null), not an expected limit: at 200/page that
 * is 200,000 users before this gives up and reports an error rather than
 * looping forever.
 */
const LIST_USERS_PAGE_SIZE = 200;
const LIST_USERS_MAX_PAGES = 1000;

async function findAuthUserByEmail(
  admin: SupabaseClient,
  targetEmail: string
): Promise<{ user: User | null; error: string | null }> {
  let page = 1;
  for (let pagesRead = 0; pagesRead < LIST_USERS_MAX_PAGES; pagesRead++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: LIST_USERS_PAGE_SIZE });
    if (error) return { user: null, error: error.message };

    const match = data.users.find(u => canonicalEmail(u.email) === targetEmail);
    if (match) return { user: match, error: null };

    if (!('nextPage' in data) || data.nextPage === null) return { user: null, error: null };
    page = data.nextPage;
  }
  return {
    user: null,
    error: `Exceeded ${LIST_USERS_MAX_PAGES} pages while searching for an existing Auth user; refusing to loop further.`
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return json({ success: false, code: 'invalid_input', message: 'POST only.' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');

  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    console.error('provision-staff: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY in the function environment.');
    return json({ success: false, code: 'internal_error', message: 'Server is not configured.' }, 500);
  }

  // 1. Who is calling? Verified against Supabase's own Auth server via this
  // caller-scoped client — never a locally-decoded JWT payload.
  const authHeader = req.headers.get('Authorization') ?? '';
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false }
  });

  const { data: callerAuth, error: callerAuthError } = await callerClient.auth.getUser();
  if (callerAuthError || !callerAuth?.user) {
    return json({ success: false, code: 'unauthenticated', message: 'Sign in required.' }, 401);
  }
  const callerId = callerAuth.user.id;

  // 2. Everything privileged from here on uses the service-role client. Its
  // key never leaves this runtime.
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // 3. Server-side authorization: is the CALLER an active Super Admin, per
  // the staff table itself — never a client-supplied role/isAdmin claim, and
  // never UI visibility. Mirrors public.is_super_admin() exactly.
  const { data: callerStaff, error: callerStaffError } = await admin
    .from('staff')
    .select('id, role, has_console_access, status')
    .eq('user_id', callerId)
    .maybeSingle();

  if (callerStaffError) {
    console.error('provision-staff: caller authorization lookup failed:', callerStaffError.message);
    return json({ success: false, code: 'internal_error', message: 'Could not verify authorization.' }, 500);
  }

  const callerIsActiveSuperAdmin =
    !!callerStaff &&
    callerStaff.role === 'Super Admin' &&
    callerStaff.has_console_access === true &&
    callerStaff.status !== 'Inactive' &&
    callerStaff.status !== 'Former Staff';

  if (!callerIsActiveSuperAdmin) {
    return json({ success: false, code: 'forbidden', message: 'Only an active Super Admin may provision staff.' }, 403);
  }

  // 4. Parse and validate input.
  let body: ProvisionStaffRequest;
  try {
    body = await req.json();
  } catch {
    return json({ success: false, code: 'invalid_input', message: 'Invalid request body.' }, 400);
  }

  const staffId = String(body?.staffId ?? '').trim();
  if (!staffId) {
    return json({ success: false, code: 'invalid_input', message: 'staffId is required.' }, 422);
  }

  // 5. Load the target staff row. The caller never supplies email/role
  // directly — they're read from this row, so a caller cannot request
  // provisioning of an email they merely typed into the request body.
  const { data: targetRow, error: targetError } = await admin
    .from('staff')
    .select('id, user_id, email, status')
    .eq('id', staffId)
    .maybeSingle();

  if (targetError) {
    console.error('provision-staff: target staff lookup failed:', targetError.message);
    return json({ success: false, staffId, code: 'internal_error', message: 'Could not read the staff record.' }, 500);
  }

  const targetStaff: TargetStaffRow | null = targetRow
    ? {
        id: targetRow.id,
        userId: targetRow.user_id,
        email: canonicalEmail(targetRow.email),
        status: targetRow.status
      }
    : null;

  // 6. Case F — duplicate Work Email among OTHER active staff rows.
  let duplicateEmailStaff: OtherStaffRef | null = null;
  if (targetStaff?.email) {
    const { data: dupe } = await admin
      .from('staff')
      .select('id')
      .neq('id', targetStaff.id)
      .ilike('email', targetStaff.email)
      .not('status', 'in', '("Inactive","Former Staff")')
      .limit(1)
      .maybeSingle();
    duplicateEmailStaff = dupe ? { id: dupe.id } : null;
  }

  // 7. Resolve the Auth-side state needed by decideProvisioning().
  const auth: AuthLookup = {
    existingAuthUserId: null,
    existingAuthUserMarker: null,
    existingAuthUserHasCustomerRecord: false,
    linkedAuthUserEmail: null,
    linkedAuthUserMissing: false
  };
  let conflictingStaffForAuthUser: OtherStaffRef | null = null;

  if (targetStaff?.userId) {
    // Already linked (Case A/B): look the Auth user up BY ID, not by email.
    const { data: linked, error: linkedError } = await admin.auth.admin.getUserById(targetStaff.userId);
    if (linkedError || !linked?.user) {
      auth.linkedAuthUserMissing = true;
    } else {
      auth.linkedAuthUserEmail = canonicalEmail(linked.user.email);
    }
  } else if (targetStaff) {
    // Not yet linked: is there ANY existing Auth user for this email?
    // Fully paginated — see findAuthUserByEmail's own doc comment for why a
    // single-page listUsers() call (Chunk 1's version) is not safe here.
    const { user: match, error: lookupError } = await findAuthUserByEmail(admin, targetStaff.email);
    if (lookupError) {
      console.error('provision-staff: findAuthUserByEmail failed:', lookupError);
      return json({ success: false, staffId, code: 'internal_error', message: 'Could not check existing accounts.' }, 500);
    }
    if (match) {
      auth.existingAuthUserId = match.id;
      const markerStaffId = (match.app_metadata as Record<string, unknown> | undefined)?.[PROVISIONING_MARKER_KEY];
      auth.existingAuthUserMarker = typeof markerStaffId === 'string' ? { staffId: markerStaffId } : null;

      const { data: custMatch } = await admin
        .from('customers')
        .select('id')
        .eq('user_id', match.id)
        .limit(1)
        .maybeSingle();
      auth.existingAuthUserHasCustomerRecord = !!custMatch;

      const { data: otherStaff } = await admin
        .from('staff')
        .select('id')
        .eq('user_id', match.id)
        .neq('id', targetStaff.id)
        .limit(1)
        .maybeSingle();
      conflictingStaffForAuthUser = otherStaff ? { id: otherStaff.id } : null;
    }
  }

  // 8. Decide. This is the ONLY function that decides what happens — every
  // branch above only gathers facts.
  const decision = decideProvisioning({
    targetStaff,
    duplicateEmailStaff,
    conflictingStaffForAuthUser,
    auth
  });

  switch (decision.action) {
    case 'reject':
      return json({ success: false, staffId, code: decision.code, message: decision.message }, REJECT_STATUS[decision.code] ?? 409);

    case 'idempotent_success':
      return json({ success: true, staffId, status: 'already-provisioned' }, 200);

    case 'collision_review':
      return json(
        {
          success: false,
          staffId,
          code: 'identity_collision',
          message: 'An account already exists for this Work Email and is not linked to any staff record. It has NOT been touched — resolve this manually before retrying.',
          hasExistingCustomerRecord: decision.hasExistingCustomerRecord
        },
        409
      );

    case 'complete_self_heal_link': {
      // A previous call created and marked this Auth user but the
      // staff.user_id write itself failed. Complete only that write.
      const { error: updateError } = await admin
        .from('staff')
        .update({ user_id: decision.authUserId })
        .eq('id', staffId);
      if (updateError) {
        console.error('provision-staff: self-heal staff.user_id write failed:', updateError.message);
        return json({ success: false, staffId, code: 'internal_error', message: 'Could not complete provisioning. Safe to retry.' }, 500);
      }
      return json({ success: true, staffId, status: 'invited' }, 200);
    }

    case 'create_and_link': {
      if (!targetStaff) {
        return json({ success: false, staffId, code: 'not_found', message: 'No staff record with that id.' }, 404);
      }

      // a. Create + send Supabase's built-in invite email in one call.
      //
      // redirectTo is explicit rather than left to fall back to the
      // project's Auth "Site URL" default: that default lives only in the
      // Dashboard (this repo has no supabase/config.toml to declare it),
      // so it silently drifted to a leftover local-dev address and every
      // invite link pointed at a dead localhost URL in production. A named
      // secret makes the staff invite target independent of whatever the
      // shared Site URL happens to be set to.
      const staffSiteUrl = Deno.env.get('STAFF_SITE_URL');
      // Lowercased and trimmed, like every sign-in, so the login account's
      // address never depends on how the staff record was typed.
      const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(
        canonicalEmail(targetStaff.email),
        staffSiteUrl ? { redirectTo: staffSiteUrl } : undefined
      );
      if (inviteError || !invited?.user) {
        console.error('provision-staff: inviteUserByEmail failed:', inviteError?.message);
        return json({ success: false, staffId, code: 'internal_error', message: 'Could not create the account. Safe to retry.' }, 500);
      }
      const newAuthId = invited.user.id;

      // b. Stamp the unforgeable self-heal marker BEFORE writing
      // staff.user_id, so a retry after a failure on step (c) recognizes
      // this exact identity as its own rather than treating it as an
      // unknown collision. If this specific call fails, a retry will find
      // an unmarked existing Auth user and safely fall into collision_review
      // instead — a known, deliberate, documented limitation (see the final
      // report), not a silent gap.
      const { error: markError } = await admin.auth.admin.updateUserById(newAuthId, {
        app_metadata: { [PROVISIONING_MARKER_KEY]: staffId }
      });
      if (markError) {
        console.error('provision-staff: could not stamp provisioning marker:', markError.message);
        return json({ success: false, staffId, code: 'internal_error', message: 'Could not finish provisioning. Retry — if it now reports a collision, contact an engineer rather than retrying again.' }, 500);
      }

      // c. Establish the relationship.
      const { error: linkError } = await admin.from('staff').update({ user_id: newAuthId }).eq('id', staffId);
      if (linkError) {
        console.error('provision-staff: staff.user_id write failed after invite:', linkError.message);
        return json({ success: false, staffId, code: 'internal_error', message: 'Account created but not yet linked. Safe to retry — it will complete automatically.' }, 500);
      }

      return json({ success: true, staffId, status: 'invited' }, 200);
    }

    default:
      return json({ success: false, staffId, code: 'internal_error', message: 'Unexpected state.' }, 500);
  }
});
