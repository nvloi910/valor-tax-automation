import { parseGhlDate } from "./irs-logics.js";
import { formatReadableDate } from "./webhook.js";
import { OFFICER_APPOINTMENT_TASK_TEMPLATE } from "./officer-appointment-task.template.js";

let cachedTemplate = null;

export function escapeHtml(value) {
  if (value === undefined || value === null || value === "") return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function loadOfficerTaskTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = OFFICER_APPOINTMENT_TASK_TEMPLATE;
  }
  return cachedTemplate;
}

function replaceAll(template, key, value) {
  return template.split(`{{${key}}}`).join(value ?? "");
}

function parseCommentField(comments, label) {
  if (!comments) return undefined;
  const pattern = new RegExp(`^${label}:\\s*(.+)$`, "im");
  const match = comments.match(pattern);
  return match?.[1]?.trim();
}

function formatAppointmentTime(raw, fromGhlApi = false) {
  if (!raw) return undefined;
  const parsed = parseGhlDate(raw, { fromGhlApi });
  return formatReadableDate(parsed || raw);
}

export function extractBookingFields({ normalized = {}, taskDetails = {} }) {
  const contactName = [normalized.firstName, normalized.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();

  let appointmentTitle = normalized.appointmentTitle?.trim();
  if (!appointmentTitle && taskDetails.subject) {
    const withoutPrefix = taskDetails.subject.replace(/^Appointment:\s*/i, "").trim();
    const dashIndex = withoutPrefix.indexOf(" — ");
    appointmentTitle =
      dashIndex > 0 ? withoutPrefix.slice(0, dashIndex).trim() : withoutPrefix;
  }

  const comments = taskDetails.comments || "";
  const appointmentStart =
    formatAppointmentTime(normalized.appointmentStart) ||
    parseCommentField(comments, "Appointment Start");
  const appointmentEnd =
    formatAppointmentTime(normalized.appointmentEnd) ||
    parseCommentField(comments, "Appointment End");
  const aiSummary =
    normalized.aiSummary?.trim() || parseCommentField(comments, "AI Summary");
  const aiTranscript =
    normalized.aiTranscript?.trim() || parseCommentField(comments, "Transcript");

  return {
    contactName,
    appointmentTitle,
    appointmentStart,
    appointmentEnd,
    calendarName: normalized.calendarName?.trim() || parseCommentField(comments, "Calendar"),
    aiSummary,
    aiTranscript,
  };
}

function optionalTextBlock(label, value) {
  if (!value?.trim()) return "";
  return `<div class="field" style="flex-direction: column;">
    <span class="label" style="margin-bottom: 8px;">${escapeHtml(label)}:</span>
    <div class="details-block">${escapeHtml(value.trim())}</div>
  </div>`;
}

function displayValue(value) {
  return escapeHtml(value) || "—";
}

/**
 * Render branded HTML for settlement officer appointment booking notification.
 */
export function renderOfficerTaskEmailHtml({
  caseId,
  taskId,
  taskDetails,
  normalized = {},
  officerName,
  assignmentMethod,
  sourceTag,
  template = loadOfficerTaskTemplate(),
}) {
  const booking = extractBookingFields({ normalized, taskDetails });

  const assignmentLabel = assignmentMethod
    ? String(assignmentMethod).replace(/_/g, " ")
    : "—";

  const sourceBadge = sourceTag
    ? `<p style="text-align: center;"><span class="badge">${escapeHtml(sourceTag)}</span></p>`
    : "";

  let html = template;
  html = replaceAll(html, "OFFICER_NAME", displayValue(officerName || "Settlement Officer"));
  html = replaceAll(html, "CONTACT_NAME", displayValue(booking.contactName));
  html = replaceAll(html, "CONTACT_EMAIL", displayValue(normalized.email));
  html = replaceAll(html, "CONTACT_PHONE", displayValue(normalized.phone));
  html = replaceAll(html, "APPOINTMENT_TITLE", displayValue(booking.appointmentTitle));
  html = replaceAll(html, "APPOINTMENT_START", displayValue(booking.appointmentStart));
  html = replaceAll(html, "APPOINTMENT_END", displayValue(booking.appointmentEnd));
  html = replaceAll(html, "CALENDAR_NAME", displayValue(booking.calendarName));
  html = replaceAll(html, "CASE_ID", displayValue(caseId));
  html = replaceAll(html, "TASK_ID", displayValue(taskId));
  html = replaceAll(html, "TASK_SUBJECT", displayValue(taskDetails?.subject));
  html = replaceAll(html, "ASSIGNMENT_METHOD", displayValue(assignmentLabel));
  html = replaceAll(html, "SOURCE_BADGE", sourceBadge);
  html = replaceAll(html, "AI_SUMMARY_BLOCK", optionalTextBlock("AI summary", booking.aiSummary));
  html = replaceAll(
    html,
    "AI_TRANSCRIPT_BLOCK",
    optionalTextBlock("Conversation transcript", booking.aiTranscript)
  );

  return html;
}
