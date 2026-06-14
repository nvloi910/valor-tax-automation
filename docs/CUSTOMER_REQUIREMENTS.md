# Customer requirements — tracking

Use this list to mark work as you complete it. Checkboxes: `- [ ]` = not done, `- [x]` = done.

---

## 1. Cancellation — stop retries when appointment is cancelled

**Step-by-step implementation:** [TASK_1_CANCELLATION_IMPLEMENTATION.md](./TASK_1_CANCELLATION_IMPLEMENTATION.md)

- [ ] **1.1** When a lead cancels, the system must **not** keep retrying (e.g. resolving missing appointment time).
- [ ] **1.2** GHL: workflow on **appointment cancelled** (or equivalent) → **apply a tag** (e.g. for CRM visibility).
- [ ] **1.3** GHL: same workflow (or follow-up action) → **outbound webhook** to Valor with cancel payload.
- [ ] **1.4** Valor: new **API route** (e.g. `POST /api/ghl-cancel`) that verifies a **shared secret** and accepts cancel payload.
- [ ] **1.5** Supabase: add **`ghl_contact_id`** (and ideally **`ghl_appointment_id`**) on `pending_tasks` if not present.
- [ ] **1.6** Valor: when **enqueueing** `pending_tasks`, **persist** GHL contact / appointment ids from normalized webhook payload.
- [ ] **1.7** Valor: cancel handler **finds** matching `pending_tasks` (`pending` / `processing`) and sets status to **`cancelled`** (or agreed terminal state) so **cron** skips them.
- [ ] **1.8** (Optional) Log cancel events to `task_logs` or equivalent for **audit** / dashboard.
- [ ] **1.9** **Test**: pending row → cancel in GHL → webhook → row no longer retried; cron does not process it.

---

## 2. Chat / leads — require email or phone before booking

- [ ] **2.1** GHL: **Conversation AI / bot** — instructions so the bot **prioritises collecting email or phone** before deeper help or booking.
- [ ] **2.2** GHL: **do not** expose booking / calendar / “schedule” actions until **email or phone** exists (workflow branch or custom fields).
- [ ] **2.3** GHL: **workflow** — if contact has **neither** email **nor** phone, route to **contact collection only**; no Valor **appointment** webhook in that state.
- [ ] **2.4** GHL: align **chat** behaviour with **form** leads (forms already capture contact info; chat should meet the **same bar**).
- [ ] **2.5** **Document** for the team: Valor’s **book** webhook should only run when **email and/or phone** is present (matches IRS Logics lookup).

---

## 3. Sign-off

- [ ] **3.1** Customer **reviewed** cancellation flow (GHL + Valor end-to-end).
- [ ] **3.2** Customer **reviewed** chat / qualification rules in GHL.

---

*Source: product discussion — Valor Tax automation (GHL → IRS Logics, Supabase).*
