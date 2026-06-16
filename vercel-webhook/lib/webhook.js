import { formatPhone, parseGhlDate } from "./irs-logics.js";

/**
 * Convert a UTC ISO string to a Pacific-time ISO string without the Z suffix.
 * IRS Logics interprets DueDate/Reminder in its own local timezone, so sending
 * raw UTC causes a 2–3 hour shift. Valor operates in California (Pacific),
 * so we convert to Pacific before sending.
 * e.g. "2026-04-06T22:30:00.000Z" → "2026-04-06T15:30:00" (3:30 PM PDT)
 */
export function toPacificISO(utcIso) {
  if (!utcIso) return utcIso;
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return utcIso;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

/**
 * IRS Logics Task API expects Pacific wall-clock datetimes without a Z suffix.
 * Sending raw UTC (…Z) makes DueDate look OK but Reminder drifts (e.g. 4 PM → 5 AM next day).
 */
export function formatTaskDatesForIrsLogics(taskDetails) {
  if (!taskDetails?.dueDate) return {};
  return {
    DueDate: toPacificISO(taskDetails.dueDate),
    Reminder: toPacificISO(taskDetails.reminder ?? taskDetails.dueDate),
    ...(taskDetails.endDate ? { EndDate: toPacificISO(taskDetails.endDate) } : {}),
  };
}

/**
 * Format an ISO date string into a human-readable form.
 * e.g. "2026-03-31T21:30:00.000Z" → "Mar 31, 2026 at 2:30 PM (PDT)"
 * Falls back to the raw value if parsing fails.
 */
export function formatReadableDate(isoOrRaw) {
  if (!isoOrRaw) return undefined;
  const d = new Date(isoOrRaw);
  if (Number.isNaN(d.getTime())) return String(isoOrRaw);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
    timeZone: "America/Los_Angeles",
  });
}

export function pickFirstValue(source, ...keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return undefined;
}

function stringifyField(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    return value.name || value.title || value.value || JSON.stringify(value);
  }
  return String(value);
}

export function normalizeWebhookPayload(body = {}) {
  return {
    firstName: pickFirstValue(body, "First Name", "first_name"),
    lastName: pickFirstValue(body, "Last Name", "last_name"),
    email: pickFirstValue(body, "Email", "email"),
    phone: formatPhone(pickFirstValue(body, "Phone", "phone")),
    appointmentTitle: pickFirstValue(body, "appointment_title", "title"),
    appointmentStart: pickFirstValue(
      body,
      "appointment_start_time",
      "start_time",
      "startTime",
      "selected_slot",
    ),
    appointmentEnd: pickFirstValue(
      body,
      "appointment_end_time",
      "end_time",
      "endTime",
    ),
    calendarName: stringifyField(
      pickFirstValue(body, "calender", "calendar", "calendar_name"),
    ),
    aiSummary: pickFirstValue(body, "conversations_ai_summary"),
    aiTranscript: pickFirstValue(body, "conversations_ai_transcript"),
  };
}

export function buildTaskDetails(payload) {
  const contactName =
    [payload.firstName, payload.lastName].filter(Boolean).join(" ").trim();
  const appointmentTitle = payload.appointmentTitle || contactName;

  const parsedStart = parseGhlDate(payload.appointmentStart);
  const endDate = parseGhlDate(payload.appointmentEnd);

  // Hard invariant: tasks must have a real appointment time. If parsedStart is
  // missing, dueDate/reminder are returned as null and callers MUST refuse to
  // create the task — never fall back to processing time, which produces
  // wrong-time tasks that officers act on. Use canCreateTask() to check.
  const dueDate = parsedStart || null;

  // Build a human-readable time string for the subject line
  const readableStart = formatReadableDate(parsedStart || payload.appointmentStart);
  const readableEnd = formatReadableDate(endDate || payload.appointmentEnd);
  let timeLabel = "";
  if (readableStart) {
    timeLabel = ` - ${readableStart}`;
  }

  const subject = `Appointment: ${appointmentTitle}${timeLabel}`;

  const comments = [
    payload.calendarName ? `Calendar: ${payload.calendarName}` : null,
    contactName ? `Contact: ${contactName}` : null,
    readableStart ? `Appointment Start: ${readableStart}` : null,
    readableEnd ? `Appointment End: ${readableEnd}` : null,
    payload.aiSummary ? `AI Summary: ${payload.aiSummary}` : null,
    payload.aiTranscript ? `Transcript: ${payload.aiTranscript}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    subject,
    dueDate,
    reminder: dueDate,
    endDate: endDate || undefined,
    comments: comments || undefined,
  };
}

/**
 * Guard for callers of buildTaskDetails: returns true only if the task has a
 * real appointment time. If this returns false, the caller MUST NOT call
 * createTask — defer to the pending_tasks retry loop instead.
 */
export function canCreateTask(taskDetails) {
  return Boolean(taskDetails?.dueDate);
}

export function buildCaseActivityDetails(payload, context = {}) {
  const contactName =
    [payload.firstName, payload.lastName].filter(Boolean).join(" ").trim();

  const comment = [
    "An IRS Logics task was created automatically from the GHL appointment webhook.",
    context.taskId ? `Task ID: ${context.taskId}` : null,
    context.assignedTo ? `Assigned To: ${context.assignedTo}` : null,
    context.assignmentMethod
      ? `Assignment Method: ${context.assignmentMethod}`
      : null,
    contactName ? `Contact: ${contactName}` : null,
    payload.appointmentStart
      ? `Appointment Start: ${formatReadableDate(parseGhlDate(payload.appointmentStart) || payload.appointmentStart)}`
      : null,
    payload.calendarName ? `Calendar: ${payload.calendarName}` : null,
    payload.aiSummary ? `AI Summary: ${payload.aiSummary}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    ActivityType: "General",
    Subject: `Auto Task Created: ${context.taskSubject || "Appointment Task"}`,
    Comment: comment,
    Popup: false,
    Pin: false,
  };
}
