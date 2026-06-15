import assert from "node:assert/strict";

import {
  buildTaskCreatedEmail,
  isOfficerNotifyEnabled,
  notifyOfficerTaskCreated,
} from "../../lib/notify-officer.js";

function run(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function runAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

const gmailEnv = {
  GMAIL_CLIENT_ID: "id",
  GMAIL_CLIENT_SECRET: "secret",
  GMAIL_REFRESH_TOKEN: "refresh",
  GMAIL_USER: "no-reply@example.com",
};

run("isOfficerNotifyEnabled respects GMAIL_NOTIFY_ENABLED=false", () => {
  assert.equal(isOfficerNotifyEnabled({ ...gmailEnv, GMAIL_NOTIFY_ENABLED: "false" }), false);
  assert.equal(isOfficerNotifyEnabled(gmailEnv), true);
});

run("buildTaskCreatedEmail includes case and appointment details", () => {
  const { subject, text, html } = buildTaskCreatedEmail({
    caseId: 12345,
    taskId: 99,
    officerName: "Anthony Edwards",
    assignmentMethod: "case_officer",
    sourceTag: "GHL webhook",
    normalized: {
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      phone: "(555)123-4567",
      calendarName: "Valor Tax Appointment",
    },
    taskDetails: {
      subject: "Appointment: Consultation — Jun 15, 2026, 1:00 PM PDT",
      comments: "Calendar: Valor Tax Appointment\nContact: Jane Doe",
    },
  });

  assert.ok(subject.includes("New appointment booked"));
  assert.ok(subject.includes("Jane Doe"));
  assert.ok(text.includes("--- Booking ---"));
  assert.ok(text.includes("--- Case ---"));
  assert.ok(text.includes("--- IRS Logics Task ---"));
  assert.ok(text.includes("Case ID: 12345"));
  assert.ok(text.includes("Task ID: 99"));
  assert.ok(text.includes("jane@example.com"));
  assert.ok(text.includes("GHL webhook"));
  assert.ok(html.includes("New Appointment Booked"));
  assert.ok(html.includes("Booking Information"));
  assert.ok(html.includes("Jane Doe"));
});

await runAsync("notifyOfficerTaskCreated sends when recipient resolved", async () => {
  let sent;
  const result = await notifyOfficerTaskCreated(
    {
      caseId: 12345,
      taskId: 99,
      taskDetails: { subject: "Appointment: Test", comments: "Details" },
      normalized: { firstName: "Jane", lastName: "Doe" },
      assignedOfficer: { name: "Anthony Edwards", userId: 73, email: "anthony@example.com" },
      assignmentMethod: "case_officer",
      sourceTag: "test",
    },
    {
      env: {
        ...gmailEnv,
        GMAIL_NOTIFY_MANAGERS: "manager@valortaxrelief.com",
        GMAIL_NOTIFY_BCC: "false",
      },
      resolveEmailFn: async () => ({ email: "anthony@example.com", name: "Anthony Edwards" }),
      sendFn: async (msg, options) => {
        sent = msg;
        return {
          id: "1",
          cc: ["manager@valortaxrelief.com"],
          bcc: null,
        };
      },
    }
  );

  assert.equal(result.sent, true);
  assert.equal(result.to, "anthony@example.com");
  assert.deepEqual(result.cc, ["manager@valortaxrelief.com"]);
  assert.equal(sent.to, "anthony@example.com");
  assert.ok(sent.subject.includes("New appointment booked"));
  assert.ok(sent.html.includes("New Appointment Booked"));
});

await runAsync("notifyOfficerTaskCreated skips when Gmail not configured", async () => {
  const result = await notifyOfficerTaskCreated(
    { caseId: 1, taskId: 2, taskDetails: {}, normalized: {} },
    { env: {} }
  );
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "not_configured");
});
