import { parseGhlDate } from "./irs-logics.js";
import { formatReadableDate } from "./webhook.js";

const MAX_LOG_FIELD = 500;

function truncate(value, max = MAX_LOG_FIELD) {
  if (value === undefined || value === null) return value;
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Pick appointment-related keys from the raw GHL webhook body for Vercel logs. */
export function summarizeGhlWebhookBody(body = {}) {
  const keys = [
    "First Name",
    "Last Name",
    "first_name",
    "last_name",
    "Email",
    "email",
    "Phone",
    "phone",
    "appointment_id",
    "appointment_title",
    "title",
    "appointment_start_time",
    "appointment_end_time",
    "start_time",
    "startTime",
    "end_time",
    "endTime",
    "selected_slot",
    "calender",
    "calendar",
    "calendar_name",
    "conversations_ai_summary",
    "conversations_ai_transcript",
  ];

  const summary = {};
  for (const key of keys) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== "") {
      summary[key] = truncate(body[key]);
    }
  }
  return summary;
}

export function describeAppointmentTime(raw, { fromGhlApi = false } = {}) {
  if (!raw) return null;
  const parsedUtc = parseGhlDate(raw, { fromGhlApi });
  return {
    raw: String(raw),
    parsedUtc: parsedUtc || null,
    pacificDisplay: parsedUtc ? formatReadableDate(parsedUtc) : null,
    fromGhlApi,
  };
}

/** Structured JSON logs — search Vercel for `[ghl-webhook]`. */
export function logGhlWebhook(stage, data) {
  console.log(`[ghl-webhook] ${stage}`, JSON.stringify(data));
}
