# Task 1 — Cancellation flow: step-by-step implementation

This breaks down **requirement 1** (stop retries when a lead cancels) into concrete steps: **database → code → env → GHL → verify**.

**Goal:** A GHL cancel event calls your app; matching rows in `pending_tasks` move to **`cancelled`**. Cron already only loads `status in (pending, processing)`, so **`cancelled` rows are ignored** — no change needed there.

---

## Phase A — Supabase (schema)

### A.1 Add columns

Run in **Supabase SQL Editor** (or `supabase db query --linked` if you use CLI):

- `ghl_contact_id` — `TEXT`, nullable (GHL contact id from webhook)
- `ghl_appointment_id` — `TEXT`, nullable (GHL appointment/event id, if you can send it from both book and cancel)

Optional index (helps cancel lookups later):

- `CREATE INDEX IF NOT EXISTS idx_pending_tasks_ghl_contact ON pending_tasks (ghl_contact_id) WHERE ghl_contact_id IS NOT NULL;`
- `CREATE INDEX IF NOT EXISTS idx_pending_tasks_ghl_appt ON pending_tasks (ghl_appointment_id) WHERE ghl_appointment_id IS NOT NULL;`

### A.2 Check constraint (optional but clean)

- Allow `status` to include `cancelled` (if you use a `CHECK` today, extend it; if `status` is free text, nothing to do).

### A.3 Mirror in repo

- Add a migration file under `vercel-webhook/supabase/` (e.g. `add_ghl_ids_and_cancelled_status.sql`) so production and repo stay aligned.

**Done when:** Table has the two new columns; migration file committed.

---

## Phase B — Normalize the *book* webhook (capture IDs for matching)

### B.1 Extend `normalizeWebhookPayload` in `vercel-webhook/lib/webhook.js`

- Add fields to the returned object, e.g.:
  - `ghlContactId` — from GHL’s payload (see **B.2** for field names to try)
  - `appointmentId` (or `ghlAppointmentId`) — from `appointment_id` / variants you already use in workflows

**Implementation pattern:** use the same `pickFirstValue(body, "key1", "key2", …)` style as for name/email, because GHL custom webhook shapes vary.

### B.2 Confirm field names in GHL (one-time)

- Open your **Appointment Booked** workflow → **Outbound Webhook** → see which **custom values** you can send (contact id, appointment id).
- GHL often exposes things like `{{contact.id}}` / `{{appointment.id}}` (exact tokens depend on your GHL version). Add them to the payload with **stable JSON keys** your code expects (e.g. `ghl_contact_id`, `ghl_appointment_id` in the top-level body).

**Done when:** A test booking shows `ghlContactId` / `appointmentId` populated in `normalized` (log once or unit test with sample body).

---

## Phase C — Persist IDs on `pending_tasks`

### C.1 Update `buildPendingEntry` in `vercel-webhook/lib/pending.js`

- Map `normalized.ghlContactId` → `ghl_contact_id`
- Map `normalized.appointmentId` (or your chosen name) → `ghl_appointment_id`

### C.2 No route changes for inserts

- All `insertPendingTask` calls go through `buildPendingEntry` from `ghl-webhook/route.js` only — so **one** change to `buildPendingEntry` covers every queue reason (`missing_appointment`, `case_not_found`, `missing_contact_info`, `task_failed`).

### C.3 Tests

- Update `vercel-webhook/tests/lib/pending.test.mjs` so at least one `buildPendingEntry` case asserts the new columns when the normalized object includes GHL ids.

**Done when:** New pending rows in Supabase show `ghl_contact_id` / `ghl_appointment_id` when GHL sent them.

---

## Phase D — Cancel API route

### D.1 New file `vercel-webhook/app/api/ghl-cancel/route.js` (or `ghl-appointment-cancelled/route.js`)

- **Method:** `POST`
- **Auth:** Require `Authorization: Bearer <secret>` (same style as `CRON_SECRET` in `process-pending`)
- **Body (JSON),** e.g.:
  - `ghl_appointment_id` (best single match) **or**
  - `ghl_contact_id` (cancel all open pending for that contact) **or**
  - fallback: `email` / `phone` (normalize phone the same way as `formatPhone` in `irs-logics` / `webhook.js` for consistency)

**Matching rule (suggested order):**

1. If `ghl_appointment_id` present → `PATCH` all rows where `status in ('pending','processing')` and `ghl_appointment_id` matches.
2. Else if `ghl_contact_id` → same filter on `ghl_contact_id`.
3. Else if email and/or phone → match normalized email/phone on `pending_tasks`.

**Action:** set `status = 'cancelled'`, `updated_at = now`, optional `error_message = 'cancelled via GHL webhook'`.

- **Response:** `{ "cancelled": <number> }` or list of updated ids for debugging.

### D.2 Helper in `vercel-webhook/lib/pending.js` (optional but clean)

- e.g. `cancelPendingTasks({ ghlAppointmentId, ghlContactId, email, phone })` using `getSupabaseAdmin()` or `supabaseRest` PATCH with filters (PostgREST `or` / multiple queries if needed).

### D.3 Env var

- e.g. `GHL_CANCEL_WEBHOOK_SECRET` in `.env` and `.env.example` (or reuse `CRON_SECRET` if the team accepts one shared secret for server-to-server — document the choice).

### D.4 Vercel

- Add the new env in Vercel project settings after deploy.

**Done when:** `curl` with the secret updates matching rows to `cancelled`.

---

## Phase E — Optional: audit in `task_logs`

- In `ghl-cancel` route, after successful cancel, call existing `insertTaskLog` (or a thin wrapper) with `status: 'cancelled'` or a string your dashboard can show — **only if** you want the overview to show “cancelled from GHL” without opening Supabase.

**Done when:** (If you did this) one log line per cancel batch or per contact.

---

## Phase G — GHL configuration (no repo)

### G.1 New workflow: “Appointment cancelled” (or the trigger GHL provides)

1. **Trigger:** Appointment / calendar **cancelled** (exact name in your GHC UI).
2. **Actions:**
   - **Add tag** — e.g. `irs-sync-cancelled` (so staff see it in CRM).
   - **Outbound Webhook** — `POST` to `https://<your-vercel-domain>/api/ghl-cancel` with the **same** `ghl_contact_id` / `ghl_appointment_id` (and email/phone as backup) you now send on book.

3. **Headers:** `Authorization: Bearer <GHL_CANCEL_WEBHOOK_SECRET>`, `Content-Type: application/json`

### G.2 Publish and test in GHL

- Use a test contact: create appointment → let something queue in `pending_tasks` (or insert a test row) → cancel appointment → confirm webhook fires and rows flip to `cancelled`.

**Done when:** Real cancel from GHI updates your DB in production (or staging).

---

## Phase H — Verification checklist

- [ ] **Schema:** `ghl_contact_id`, `ghl_appointment_id` exist; migration in repo.
- [ ] **Book webhook:** GHL sends ids; `normalizeWebhookPayload` + `buildPendingEntry` store them.
- [ ] **Cancel route:** Returns 401 without secret; 200 and `cancelled` count with secret; rows no longer `pending`/`processing`.
- [ ] **Cron:** No code change required; confirm a `cancelled` row is **not** picked by `buildPendingTasksQuery` (spot-check after 5+ minutes).
- [ ] **Dashboard:** `getPendingCount()` only counts `pending`+`processing` — cancelled should **lower** the pending number after cancel (if that row was still pending).
- [ ] **Edge case:** If cancel webhook has **no** ids and no email/phone, document that you return `400` with a clear message so GHL can fix the payload.

---

## Order to implement (summary)

1. **A** — DB columns + migration file  
2. **B** — GHL book payload + `normalizeWebhookPayload`  
3. **C** — `buildPendingEntry` + tests  
4. **D** — `/api/ghl-cancel` + env  
5. **E** — optional `task_logs`  
6. **G** — GHL cancel workflow + webhook  
7. **H** — full verification  

---

## Out of scope (for later)

- **Safety net** creating a task for a “cancelled” lead — if that ever happens, you’d need business rules (e.g. GHL tag check in code). Not required for “stop `pending_tasks` retries.”
- **Deleting** IRS Logics tasks that were already created — only discussed if the customer asks; this task is **queue cancellation**, not task deletion in IRS.
