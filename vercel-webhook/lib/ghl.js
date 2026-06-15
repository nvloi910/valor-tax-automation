import {
  fetchAppointmentByContactIdFromMcp,
  fetchAppointmentFromMcp,
  findGhlContactByNameViaMcp,
  findGhlContactIdViaMcp,
  isGhlMcpConfigured,
} from "./ghl-mcp.js";
import { parseGhlDate } from "./irs-logics.js";

const GHL_BASE = "https://services.leadconnectorhq.com";

function getGhlHeaders() {
  if (!process.env.GHL_API_KEY) {
    throw new Error("Missing GHL_API_KEY");
  }

  return {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    Version: "2021-07-28",
  };
}

function hasAppointmentData(value) {
  return Boolean(value?.appointmentStart || value?.startTime);
}

/** GHL REST/MCP returns UTC "YYYY-MM-DD HH:mm:ss" — normalize to ISO for downstream. */
function normalizeGhlApiAppointmentFields(fields) {
  if (!fields || typeof fields !== "object") return fields;
  const out = { ...fields };
  if (out.appointmentStart) {
    out.appointmentStart =
      parseGhlDate(out.appointmentStart, { fromGhlApi: true }) || out.appointmentStart;
  }
  if (out.appointmentEnd) {
    out.appointmentEnd =
      parseGhlDate(out.appointmentEnd, { fromGhlApi: true }) || out.appointmentEnd;
  }
  return out;
}

async function findGhlContactRest(email, phone) {
  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) return null;

  const query = email || phone;
  if (!query) return null;

  const url = `${GHL_BASE}/contacts/?locationId=${encodeURIComponent(locationId)}&query=${encodeURIComponent(query)}&limit=1`;

  const res = await fetch(url, { headers: getGhlHeaders(), cache: "no-store" });
  if (!res.ok) return null;

  const data = await res.json();
  return data.contacts?.[0]?.id || null;
}

async function getContactAppointmentRest(contactId) {
  if (!contactId) return null;

  const url = `${GHL_BASE}/contacts/${contactId}/appointments`;
  const res = await fetch(url, { headers: getGhlHeaders(), cache: "no-store" });
  if (!res.ok) return null;

  const data = await res.json();
  const events = data.events;
  if (!events || events.length === 0) return null;

  const sorted = [...events].sort(
    (a, b) => new Date(b.dateAdded) - new Date(a.dateAdded)
  );
  const event = sorted[0];

  return {
    startTime: event.startTime || null,
    endTime: event.endTime || null,
    title: event.title || null,
    calendarId: event.calendarId || null,
    calendarName: event.calendarName || event.calendar?.name || null,
  };
}

async function getCalendarNameRest(calendarId) {
  if (!calendarId) return null;

  const url = `${GHL_BASE}/calendars/${calendarId}`;
  const res = await fetch(url, { headers: getGhlHeaders(), cache: "no-store" });
  if (!res.ok) return null;

  const data = await res.json();
  return data.calendar?.name || null;
}

export function scoreNameMatch(contact, firstName, lastName) {
  const cFirst = (contact.firstName || contact.first_name || "").toLowerCase();
  const cLast = (contact.lastName || contact.last_name || "").toLowerCase();
  const tFirst = (firstName || "").toLowerCase();
  const tLast = (lastName || "").toLowerCase();

  if (cFirst === tFirst && cLast === tLast) return 3;
  if (cLast === tLast) return 2;
  if (cFirst === tFirst) return 1;
  return 0;
}

async function findGhlContactByNameRest(name, firstName, lastName) {
  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId || !name) return null;

  const url = `${GHL_BASE}/contacts/?locationId=${encodeURIComponent(locationId)}&query=${encodeURIComponent(name)}&limit=5`;

  try {
    const res = await fetch(url, { headers: getGhlHeaders(), cache: "no-store" });
    if (!res.ok) return null;

    const data = await res.json();
    const contacts = data.contacts;
    if (!contacts || contacts.length === 0) return null;

    // Score each contact by name similarity, pick best match
    const scored = contacts
      .map((c) => ({ ...c, _score: scoreNameMatch(c, firstName, lastName) }))
      .sort((a, b) => b._score - a._score);

    const best = scored[0];
    if (best._score === 0) return null;

    return {
      id: best.id || null,
      email: best.email || null,
      phone: best.phone || null,
    };
  } catch (error) {
    console.error("GHL REST name search failed:", error.message);
    return null;
  }
}

/**
 * Search GHL REST for a contact and return the full record (not just the ID).
 */
async function findGhlContactRecordRest(email, phone) {
  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) return null;

  const query = email || phone;
  if (!query) return null;

  const url = `${GHL_BASE}/contacts/?locationId=${encodeURIComponent(locationId)}&query=${encodeURIComponent(query)}&limit=1`;

  const res = await fetch(url, { headers: getGhlHeaders(), cache: "no-store" });
  if (!res.ok) return null;

  const data = await res.json();
  return data.contacts?.[0] || null;
}

function collectContactInfo(contact) {
  if (!contact) return { emails: [], phones: [], firstName: undefined, lastName: undefined };

  const emails = [];
  const phones = [];

  if (contact.email) emails.push(contact.email);
  if (contact.additionalEmails) {
    for (const e of contact.additionalEmails) {
      if (e && !emails.includes(e)) emails.push(e);
    }
  }

  if (contact.phone) phones.push(contact.phone);
  if (contact.additionalPhones) {
    for (const p of contact.additionalPhones) {
      if (p && !phones.includes(p)) phones.push(p);
    }
  }

  return {
    emails,
    phones,
    firstName: contact.firstName || contact.first_name || undefined,
    lastName: contact.lastName || contact.last_name || undefined,
  };
}

/**
 * Dependency-injectable version for testing.
 */
export async function enrichContactInfoWithProvider(email, phone, { restSearcher = findGhlContactRecordRest } = {}) {
  try {
    const contact = await restSearcher(email, phone);
    return collectContactInfo(contact);
  } catch (error) {
    console.error("GHL contact enrichment failed:", error.message);
    return { emails: [], phones: [], firstName: undefined, lastName: undefined };
  }
}

/**
 * Query GHL for the full contact record and extract all emails/phones.
 * Used by the cron on retry 2+ to discover alternate contact info.
 */
export async function enrichContactInfo(email, phone) {
  return enrichContactInfoWithProvider(email, phone);
}

/**
 * Find a GHL contact by name. Tries REST first, falls back to MCP.
 * Returns { id, email, phone } or null.
 */
export async function findGhlContactByName(name, firstName, lastName) {
  try {
    const restResult = await findGhlContactByNameRest(name, firstName, lastName);
    if (restResult?.email || restResult?.phone) {
      return restResult;
    }
  } catch (error) {
    console.error("GHL REST name lookup failed:", error.message);
  }

  try {
    return await findGhlContactByNameViaMcp(name);
  } catch (error) {
    console.error("GHL MCP name lookup failed:", error.message);
    return null;
  }
}

export function getGhlRecoveryMode(env = process.env) {
  const hasRest = Boolean(env.GHL_API_KEY);
  const hasMcp = isGhlMcpConfigured(env);

  if (hasRest && hasMcp) return "REST + MCP";
  if (hasMcp) return "MCP only";
  if (hasRest) return "REST only";
  return "Not configured";
}

/**
 * Search for a GHL contact by email or phone and return the contactId.
 */
export async function findGhlContact(email, phone) {
  try {
    const contactId = await findGhlContactRest(email, phone);
    if (contactId) {
      return contactId;
    }
  } catch (error) {
    console.error("GHL REST contact search failed:", error.message);
  }

  return findGhlContactIdViaMcp(email, phone);
}

/**
 * Get the most recent appointment for a GHL contact.
 * Returns { startTime, endTime, title, calendarId } or null.
 */
export async function getContactAppointment(contactId) {
  try {
    const appointment = await getContactAppointmentRest(contactId);
    if (appointment) {
      return appointment;
    }
  } catch (error) {
    console.error("GHL REST appointment fetch failed:", error.message);
  }

  return fetchAppointmentByContactIdFromMcp(contactId);
}

/**
 * Get the calendar name by calendarId.
 */
export async function getCalendarName(calendarId) {
  try {
    return await getCalendarNameRest(calendarId);
  } catch (error) {
    console.error("GHL REST calendar fetch failed:", error.message);
    return null;
  }
}

/**
 * Fetch appointment details from GHL API for a contact.
 * Used as a fallback when the webhook payload is missing appointment fields.
 * Returns enriched fields or empty object.
 */
async function fetchAppointmentFromRest(email, phone) {
  const contactId = await findGhlContactRest(email, phone);
  if (!contactId) return {};

  const appointment = await getContactAppointmentRest(contactId);
  if (!appointment?.startTime) return {};

  let calendarName = appointment.calendarName || null;
  if (!calendarName && appointment.calendarId) {
    calendarName = await getCalendarNameRest(appointment.calendarId);
  }

  return normalizeGhlApiAppointmentFields({
    appointmentTitle: appointment.title || undefined,
    appointmentStart: appointment.startTime || undefined,
    appointmentEnd: appointment.endTime || undefined,
    calendarName: calendarName || undefined,
  });
}

export async function fetchAppointmentFromGhlWithProviders(
  { email, phone },
  { restFetcher = fetchAppointmentFromRest, mcpFetcher = fetchAppointmentFromMcp } = {}
) {
  try {
    const restResult = await restFetcher(email, phone);
    if (hasAppointmentData(restResult)) {
      return {
        ...normalizeGhlApiAppointmentFields(restResult),
        recoverySource: "rest",
      };
    }
  } catch (error) {
    console.error("GHL REST fallback failed:", error.message);
  }

  try {
    const mcpResult = await mcpFetcher(email, phone);
    if (hasAppointmentData(mcpResult)) {
      return {
        ...normalizeGhlApiAppointmentFields(mcpResult),
        recoverySource: "mcp",
      };
    }
  } catch (error) {
    console.error("GHL MCP fallback failed:", error.message);
  }

  return {};
}

export async function fetchAppointmentFromGhl(email, phone) {
  return fetchAppointmentFromGhlWithProviders({ email, phone });
}
