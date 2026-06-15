/**
 * End-to-end datetime trace: GHL webhook JSON → normalize → parseGhlDate →
 * buildTaskDetails → IRS Logics DueDate/Reminder.
 */
import assert from "node:assert/strict";

import {
  buildTaskDetails,
  canCreateTask,
  normalizeWebhookPayload,
} from "../../lib/webhook.js";
import { parseGhlDate } from "../../lib/irs-logics.js";

function run(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function pacificDisplay(isoUtc) {
  return new Date(isoUtc).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
}

function traceWebhookToIrsDates(webhookBody) {
  const normalized = normalizeWebhookPayload(webhookBody);
  const taskDetails = buildTaskDetails(normalized);

  return {
    step3_parseGhlDate: parseGhlDate(normalized.appointmentStart),
    step4_dueDate: taskDetails.dueDate,
    step5_pacificFromDueDate: taskDetails.dueDate
      ? pacificDisplay(taskDetails.dueDate)
      : null,
    step6_irsPayload: taskDetails.dueDate
      ? { DueDate: taskDetails.dueDate, Reminder: taskDetails.reminder }
      : null,
  };
}

const JUN_15_1PM_PDT_UTC = "2026-06-15T20:00:00.000Z";
const JUN_15_1PM_PDT_DISPLAY = "Jun 15, 2026, 1:00 PM PDT";

run("pipeline: GHL human webhook (full month) → 1:00 PM PDT DueDate", () => {
  const t = traceWebhookToIrsDates({
    Email: "test@example.com",
    appointment_start_time: "Monday, June 15, 2026 1:00 PM",
  });
  assert.equal(t.step3_parseGhlDate, JUN_15_1PM_PDT_UTC);
  assert.equal(t.step5_pacificFromDueDate, JUN_15_1PM_PDT_DISPLAY);
});

run("FIXED: webhook numeric 2026-06-15 13:00:00 → 1:00 PM PDT (Pacific wall clock)", () => {
  const t = traceWebhookToIrsDates({
    Email: "client@example.com",
    appointment_start_time: "2026-06-15 13:00:00",
  });
  assert.equal(t.step4_dueDate, JUN_15_1PM_PDT_UTC);
  assert.equal(t.step5_pacificFromDueDate, JUN_15_1PM_PDT_DISPLAY);
});

run("FIXED: GHL UI label Jun 15, 2026, 01:00 PM (PDT) → 1:00 PM PDT", () => {
  assert.equal(parseGhlDate("Jun 15, 2026, 01:00 PM (PDT)"), JUN_15_1PM_PDT_UTC);
  const t = traceWebhookToIrsDates({
    Email: "client@example.com",
    appointment_start_time: "Jun 15, 2026, 01:00 PM (PDT)",
  });
  assert.equal(t.step4_dueDate, JUN_15_1PM_PDT_UTC);
  assert.equal(canCreateTask(buildTaskDetails(normalizeWebhookPayload({
    appointment_start_time: "Jun 15, 2026, 01:00 PM (PDT)",
  }))), true);
});

run("GHL API UTC numeric uses fromGhlApi (unchanged UTC semantics)", () => {
  assert.equal(
    parseGhlDate("2026-06-15 20:00:00", { fromGhlApi: true }),
    JUN_15_1PM_PDT_UTC
  );
  assert.equal(
    parseGhlDate("2026-04-12 18:00:00", { fromGhlApi: true }),
    "2026-04-12T18:00:00.000Z"
  );
});

run("pipeline: abbreviated month Jun 15, 2026 01:00 PM", () => {
  assert.equal(parseGhlDate("Jun 15, 2026 01:00 PM"), JUN_15_1PM_PDT_UTC);
});

console.log("\nDatetime pipeline trace complete.");
