import { sendGmail, isGmailConfigured, resolveGmailNotifyBcc } from "./gmail.js";
import { getCaseOfficer, getSettlementOfficerEmail } from "./irs-logics.js";
import { renderOfficerTaskEmailHtml, extractBookingFields } from "./email-templates.js";

export function isOfficerNotifyEnabled(env = process.env) {
  if (env.GMAIL_NOTIFY_ENABLED === "false") return false;
  return isGmailConfigured(env);
}

/**
 * Resolve settlement / case officer email for notifications.
 */
export async function resolveOfficerNotifyEmail(caseId, assignedOfficer) {
  const caseOfficer = await getCaseOfficer(caseId);
  if (caseOfficer?.email) {
    return { email: caseOfficer.email.trim(), name: caseOfficer.name };
  }

  const settlementEmail = await getSettlementOfficerEmail(caseId);
  if (settlementEmail?.includes("@")) {
    return {
      email: settlementEmail.trim(),
      name: assignedOfficer?.name || caseOfficer?.name || null,
    };
  }

  if (assignedOfficer?.email?.includes("@")) {
    return {
      email: assignedOfficer.email.trim(),
      name: assignedOfficer.name || null,
    };
  }

  return null;
}

export function buildTaskCreatedEmail({
  normalized = {},
  taskDetails,
  caseId,
  taskId,
  officerName,
  assignmentMethod,
  sourceTag,
}) {
  const booking = extractBookingFields({ normalized, taskDetails });

  const lines = [
    `A customer has booked a new appointment${sourceTag ? ` (${sourceTag})` : ""}.`,
    "",
    "--- Booking ---",
    booking.contactName ? `Client: ${booking.contactName}` : null,
    normalized.email ? `Email: ${normalized.email}` : null,
    normalized.phone ? `Phone: ${normalized.phone}` : null,
    booking.appointmentTitle ? `Appointment: ${booking.appointmentTitle}` : null,
    booking.appointmentStart ? `Start: ${booking.appointmentStart}` : null,
    booking.appointmentEnd ? `End: ${booking.appointmentEnd}` : null,
    booking.calendarName ? `Calendar: ${booking.calendarName}` : null,
    booking.aiSummary ? `AI Summary: ${booking.aiSummary}` : null,
    "",
    "--- Case ---",
    `Case ID: ${caseId}`,
    "",
    "--- IRS Logics Task ---",
    taskId ? `Task ID: ${taskId}` : null,
    taskDetails?.subject ? `Subject: ${taskDetails.subject}` : null,
    officerName ? `Assigned to: ${officerName}` : null,
    assignmentMethod
      ? `Assignment: ${String(assignmentMethod).replace(/_/g, " ")}`
      : null,
    "",
    "— Valor Tax Relief automation",
  ].filter((line) => line !== null);

  const subjectParts = ["New appointment booked"];
  if (booking.contactName) subjectParts.push(booking.contactName);
  if (booking.appointmentStart) subjectParts.push(booking.appointmentStart);
  const subject = subjectParts.join(" — ");

  const html = renderOfficerTaskEmailHtml({
    caseId,
    taskId,
    taskDetails,
    normalized,
    officerName,
    assignmentMethod,
    sourceTag,
  });

  return { subject, text: lines.join("\n"), html };
}

export async function notifyOfficerTaskCreated(
  {
    caseId,
    taskId,
    taskDetails,
    normalized,
    assignedOfficer,
    officerName,
    assignmentMethod,
    sourceTag,
  },
  {
    sendFn = sendGmail,
    env = process.env,
    resolveEmailFn = resolveOfficerNotifyEmail,
  } = {}
) {
  if (!isOfficerNotifyEnabled(env)) {
    return { skipped: true, reason: "not_configured" };
  }

  const recipient = await resolveEmailFn(caseId, assignedOfficer);
  if (!recipient?.email) {
    console.log(`Officer email notify skipped: no email for case ${caseId}`);
    return { skipped: true, reason: "no_officer_email" };
  }

  const { subject, text, html } = buildTaskCreatedEmail({
    normalized,
    taskDetails,
    caseId,
    taskId,
    officerName: officerName || assignedOfficer?.name,
    assignmentMethod,
    sourceTag,
  });

  const sendResult = await sendFn({ to: recipient.email, subject, text, html }, { env });
  const bcc = sendResult?.bcc ?? resolveGmailNotifyBcc(env, recipient.email);
  const bccNote = bcc ? ` (bcc: ${bcc})` : "";
  console.log(
    `Officer email sent to ${recipient.email}${bccNote} for case ${caseId}, task ${taskId}`
  );
  return { sent: true, to: recipient.email, bcc: bcc || null };
}

/** Never throws — notification failures must not break task creation. */
export async function safeNotifyOfficerTaskCreated(params) {
  try {
    return await notifyOfficerTaskCreated(params);
  } catch (error) {
    console.error("Officer email notify failed:", error.message);
    return { skipped: true, reason: "error", error: error.message };
  }
}
