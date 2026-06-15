import { findGhlContact, getContactAppointment, getCalendarName } from "./ghl.js";
import { supabaseRest } from "./supabase.js";
import { parseGhlDate } from "./irs-logics.js";

export function filterNewAppointments(ghlAppointments, existingLogs) {
  const loggedSet = new Set();

  for (const log of existingLogs) {
    if (log.email && log.appointment_start) {
      const normalizedStart = log.appointment_start.replace(/\.\d{3}Z$/, "");
      loggedSet.add(`${log.email.toLowerCase()}|${normalizedStart}`);
    }
  }

  return ghlAppointments.filter((appt) => {
    if (!appt.contactEmail || !appt.startTime) return true;
    const asUtcIso = parseGhlDate(appt.startTime);
    if (!asUtcIso) return true;
    const normalizedStart = asUtcIso.replace(/\.\d{3}Z$/, "").replace(/Z$/, "");
    const key = `${appt.contactEmail.toLowerCase()}|${normalizedStart}`;
    return !loggedSet.has(key);
  });
}

export async function fetchRecentGhlAppointments() {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recentLogs = await supabaseRest(
    `task_logs?created_at=gte.${encodeURIComponent(oneDayAgo)}&select=email,phone&order=created_at.desc`
  );

  const pendingContacts = await supabaseRest(
    `pending_tasks?status=in.(pending,processing,needs_review)&select=email,phone`
  );

  const contactMap = new Map();
  for (const row of [...(recentLogs || []), ...(pendingContacts || [])]) {
    if (row.email && !contactMap.has(row.email.toLowerCase())) {
      contactMap.set(row.email.toLowerCase(), { email: row.email, phone: row.phone });
    }
  }

  const appointments = [];

  for (const [, contact] of contactMap) {
    try {
      const contactId = await findGhlContact(contact.email, contact.phone);
      if (!contactId) continue;

      const appt = await getContactAppointment(contactId);
      if (!appt || !appt.startTime) continue;

      let calendarName = appt.calendarName || null;
      if (!calendarName && appt.calendarId) {
        calendarName = await getCalendarName(appt.calendarId);
      }

      appointments.push({
        contactEmail: contact.email,
        contactPhone: contact.phone,
        startTime: appt.startTime,
        endTime: appt.endTime,
        title: appt.title,
        calendarName,
      });
    } catch (err) {
      console.error(`Safety net: failed to check ${contact.email}:`, err.message);
    }
  }

  return appointments;
}

export async function getRecentTaskLogs() {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = await supabaseRest(
    `task_logs?created_at=gte.${encodeURIComponent(oneDayAgo)}&status=eq.success&select=email,appointment_start`
  );
  return rows || [];
}
