import assert from "node:assert/strict";

import {
  escapeHtml,
  extractBookingFields,
  renderOfficerTaskEmailHtml,
} from "../../lib/email-templates.js";

function run(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run("escapeHtml encodes special characters", () => {
  assert.equal(escapeHtml(`Tom & "Jerry" <test>`), "Tom &amp; &quot;Jerry&quot; &lt;test&gt;");
});

run("extractBookingFields pulls appointment title from task subject", () => {
  const booking = extractBookingFields({
    normalized: { firstName: "Jane", lastName: "Doe" },
    taskDetails: {
      subject: "Appointment: Consultation — Jun 15, 2026, 1:00 PM PDT",
      comments: "Calendar: Valor Tax Appointment\nAppointment Start: Jun 15, 2026, 1:00 PM PDT",
    },
  });
  assert.equal(booking.contactName, "Jane Doe");
  assert.equal(booking.appointmentTitle, "Consultation");
  assert.equal(booking.calendarName, "Valor Tax Appointment");
  assert.equal(booking.appointmentStart, "Jun 15, 2026, 1:00 PM PDT");
});

run("renderOfficerTaskEmailHtml uses booking-focused sections", () => {
  const html = renderOfficerTaskEmailHtml({
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
      appointmentTitle: "Consultation",
      appointmentStart: "2026-06-15 13:00:00",
    },
    taskDetails: {
      subject: "Appointment: Consultation — Jun 15, 2026, 1:00 PM PDT",
      comments: "Calendar: Valor Tax Appointment\nContact: Jane Doe",
    },
  });

  assert.ok(html.includes("New Appointment Booked"));
  assert.ok(html.includes("Booking Information"));
  assert.ok(html.includes("Case Information"));
  assert.ok(html.includes("IRS Logics Task"));
  assert.ok(html.includes("linear-gradient(135deg, #1e3a8a 0%, #dc2626 100%)"));
  assert.ok(html.includes("valortaxrelief.com/assets/images/logo.png"));
  assert.ok(html.includes("Hi Anthony Edwards"));
  assert.ok(html.includes("12345"));
  assert.ok(html.includes("jane@example.com"));
  assert.ok(html.includes("GHL webhook"));
  assert.ok(html.includes("Consultation"));
  assert.ok(html.includes("Honest, Transparent, and Effective Tax Solutions"));
  assert.ok(!html.includes("New Appointment Task"));
});

run("renderOfficerTaskEmailHtml escapes HTML in user content", () => {
  const html = renderOfficerTaskEmailHtml({
    caseId: 1,
    taskId: 2,
    officerName: "Test",
    normalized: { firstName: "<script>", lastName: "Alert" },
    taskDetails: { subject: "Safe", comments: "AI Summary: <b>not raw</b>" },
  });
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});
