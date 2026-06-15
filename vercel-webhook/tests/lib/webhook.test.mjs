import assert from "node:assert/strict";

import {
  buildCaseActivityDetails,
  buildTaskDetails,
  canCreateTask,
  normalizeWebhookPayload,
  pickFirstValue,
  toPacificISO,
} from "../../lib/webhook.js";
import { extractCaseId, formatPhone, parseGhlDate } from "../../lib/irs-logics.js";

function run(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run("pickFirstValue returns the first non-empty value", () => {
  const value = pickFirstValue(
    { first_name: "", "First Name": "Jane", fallback: "Ignored" },
    "first_name",
    "First Name",
    "fallback"
  );

  assert.equal(value, "Jane");
});

run("normalizeWebhookPayload supports ghl custom field names", () => {
  const payload = normalizeWebhookPayload({
    "First Name": "Jane",
    "Last Name": "Doe",
    Email: "jane@example.com",
    Phone: "15551234567",
    appointment_title: "Consultation",
    appointment_start_time: "Tuesday, March 31, 2026 3:00 PM",
    appointment_end_time: "Tuesday, March 31, 2026 3:45 PM",
    calender: "Valor Tax Appointment",
    conversations_ai_summary: "Needs help",
    conversations_ai_transcript: "Full transcript",
  });

  assert.deepEqual(payload, {
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@example.com",
    phone: "(555)123-4567",
    appointmentTitle: "Consultation",
    appointmentStart: "Tuesday, March 31, 2026 3:00 PM",
    appointmentEnd: "Tuesday, March 31, 2026 3:45 PM",
    calendarName: "Valor Tax Appointment",
    aiSummary: "Needs help",
    aiTranscript: "Full transcript",
  });
});

run("toPacificISO converts UTC to Pacific time without Z suffix", () => {
  // 10:30 PM UTC on Apr 6 = 3:30 PM PDT
  assert.equal(toPacificISO("2026-04-06T22:30:00.000Z"), "2026-04-06T15:30:00");
  // Midnight UTC on Jan 1 = 4:00 PM PST the day before (UTC-8 in winter)
  assert.equal(toPacificISO("2026-01-01T00:00:00.000Z"), "2025-12-31T16:00:00");
  // Null/undefined pass through
  assert.equal(toPacificISO(null), null);
  assert.equal(toPacificISO(undefined), undefined);
});

run("buildTaskDetails creates task subject, dates, and comments", () => {
  // Use UTC ISO inputs for timezone-independent test
  const details = buildTaskDetails({
    firstName: "Jane",
    lastName: "Doe",
    appointmentTitle: "Consultation",
    appointmentStart: "2026-04-06T22:30:00.000Z",
    appointmentEnd: "2026-04-06T23:15:00.000Z",
    calendarName: "Valor Tax Appointment",
    aiSummary: "Needs help",
    aiTranscript: "Full transcript",
  });

  assert.equal(
    details.subject,
    "Appointment: Consultation - Apr 6, 2026, 3:30 PM PDT"
  );
  // DueDate should be UTC ISO with Z — sent directly to IRS Logics
  assert.equal(details.dueDate, "2026-04-06T22:30:00.000Z");
  assert.equal(details.endDate, "2026-04-06T23:15:00.000Z");
  assert.ok(details.dueDate.endsWith("Z"), "dueDate must be UTC ISO with Z");
  assert.equal(
    details.comments,
    [
      "Calendar: Valor Tax Appointment",
      "Contact: Jane Doe",
      "Appointment Start: Apr 6, 2026, 3:30 PM PDT",
      "Appointment End: Apr 6, 2026, 4:15 PM PDT",
      "AI Summary: Needs help",
      "Transcript: Full transcript",
    ].join("\n")
  );
});

run("buildTaskDetails returns null dueDate when appointment time missing — no fake fallback", () => {
  const details = buildTaskDetails({
    firstName: "Scott",
    lastName: "Stallard",
  });

  // Subject falls back to contact name (no time suffix)
  assert.equal(details.subject, "Appointment: Scott Stallard");

  // Critical: dueDate MUST be null, not a fake processing-time fallback.
  // This is the invariant that prevents wrong-time tasks in IRS Logics.
  assert.equal(details.dueDate, null);
  assert.equal(details.reminder, null);
  assert.equal(details.endDate, undefined);

  // The old "⚠ No appointment time received" warning line must be gone —
  // we no longer emit tasks with bogus times, so the warning is obsolete.
  if (details.comments) {
    assert.ok(!details.comments.includes("⚠ No appointment time received"));
    assert.ok(!details.comments.includes("defaulted to webhook processing time"));
  }

  // canCreateTask guard must reject this payload.
  assert.equal(canCreateTask(details), false);
});

run("canCreateTask returns true only when dueDate is present", () => {
  assert.equal(canCreateTask(null), false);
  assert.equal(canCreateTask(undefined), false);
  assert.equal(canCreateTask({}), false);
  assert.equal(canCreateTask({ dueDate: null }), false);
  assert.equal(canCreateTask({ dueDate: "" }), false);
  assert.equal(canCreateTask({ dueDate: "2026-04-14T22:00:00.000Z" }), true);
});

run("buildCaseActivityDetails creates subject and comment for successful task logging", () => {
  const activity = buildCaseActivityDetails(
    {
      firstName: "Jane",
      lastName: "Doe",
      appointmentStart: "Tuesday, March 31, 2026 3:00 PM",
      calendarName: "Valor Tax Appointment",
      aiSummary: "Needs help",
    },
    {
      taskId: 98765,
      assignedTo: "Anthony Edwards",
      assignmentMethod: "case_officer",
      taskSubject: "Appointment: Consultation â€” Tuesday, March 31, 2026 3:00 PM",
    }
  );

  assert.deepEqual(activity, {
    ActivityType: "General",
    Subject: "Auto Task Created: Appointment: Consultation â€” Tuesday, March 31, 2026 3:00 PM",
    Comment: [
      "An IRS Logics task was created automatically from the GHL appointment webhook.",
      "Task ID: 98765",
      "Assigned To: Anthony Edwards",
      "Assignment Method: case_officer",
      "Contact: Jane Doe",
      "Appointment Start: Mar 31, 2026, 3:00 PM PDT",
      "Calendar: Valor Tax Appointment",
      "AI Summary: Needs help",
    ].join("\n"),
    Popup: false,
    Pin: false,
  });
});

run("normalizeWebhookPayload handles calendar as object", () => {
  const payload = normalizeWebhookPayload({
    "First Name": "Test",
    calender: { name: "Valor Tax Appointment", id: "abc123" },
  });

  assert.equal(payload.calendarName, "Valor Tax Appointment");
});

run("formatPhone normalizes 10 or 11 digit values", () => {
  assert.equal(formatPhone("5551234567"), "(555)123-4567");
  assert.equal(formatPhone("15551234567"), "(555)123-4567");
  assert.equal(formatPhone("12"), undefined);
});

run("parseGhlDate strips the weekday and returns iso output", () => {
  // GHL webhook format: "3:00 PM" is Pacific wall time (Valor is in CA).
  // March 31 = PDT (UTC-7). 3:00 PM PDT = 22:00 UTC.
  assert.equal(parseGhlDate("Tuesday, March 31, 2026 3:00 PM"), "2026-03-31T22:00:00.000Z");
  // Webhook numeric without offset = Pacific wall clock
  assert.equal(parseGhlDate("2026-06-15 13:00:00"), "2026-06-15T20:00:00.000Z");
  // GHL API UTC format
  assert.equal(parseGhlDate("2026-04-12 18:00:00", { fromGhlApi: true }), "2026-04-12T18:00:00.000Z");
  assert.equal(parseGhlDate("invalid"), undefined);
});

run("extractCaseId prefers active cases with the newest created date", () => {
  const caseId = extractCaseId({
    Success: true,
    Data: [
      { CaseID: 1, SaleDate: null, CreatedDate: "2024-01-01T00:00:00.000Z" },
      { CaseID: 2, SaleDate: "2025-05-01T00:00:00.000Z", CreatedDate: "2024-02-01T00:00:00.000Z" },
      { CaseID: 3, SaleDate: "2025-06-01T00:00:00.000Z", CreatedDate: "2024-03-01T00:00:00.000Z" },
    ],
  });

  assert.equal(caseId, 3);
});
