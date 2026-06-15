// vercel-webhook/app/api/cron/process-pending/route.js
import { NextResponse } from "next/server";
import { fetchAppointmentFromGhl, findGhlContactByName, enrichContactInfo } from "@/lib/ghl";
import { fetchAppointmentViaAgent, findContactInfoViaAgent } from "@/lib/agent";
import {
  createTask,
  createCase,
  findCase,
  findCaseExhaustive,
  getCaseOfficer,
  parseGhlDate,
} from "@/lib/irs-logics";
import { getNextOfficer, insertTaskLog } from "@/lib/supabase";
import { buildTaskDetails, canCreateTask } from "@/lib/webhook";
import {
  getPendingTasks,
  completePendingTask,
  incrementRetry,
  updatePendingTaskContactInfo,
  transitionToMissingAppointment,
  MAX_CASE_NOT_FOUND_RETRIES,
  MAX_TASK_FAILED_RETRIES,
} from "@/lib/pending";
import { isDuplicateTask } from "@/lib/dedup";
import {
  fetchRecentGhlAppointments,
  getRecentTaskLogs,
  filterNewAppointments,
} from "@/lib/safety-net";
import { safeNotifyOfficerTaskCreated } from "@/lib/notify-officer";

export const dynamic = "force-dynamic";

function isAuthorized(request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader === `Bearer ${process.env.CRON_SECRET}`) return true;
  if (process.env.NODE_ENV === "development") return true;
  return false;
}

/**
 * Escalating case search tied to retry_count:
 *   retry 0 (retry 1): basic findCase(email, phone)
 *   retry 1 (retry 2): + alt phone formats + GHL contact enrichment
 *   retry 2 (retry 3): + AI agent fuzzy match
 *   retry 3 (retry 4): auto-create the case (task only if appointment data present)
 *
 * Returns:
 *   - { caseId, lookupMethod, officer?, method? } — caller proceeds to task creation
 *   - { deferred: true } — caller must continue (task creation postponed; row parked as missing_appointment)
 *   - null — caller must continue (row already incrementRetry'd)
 */
async function escalatingCaseSearch(row, results, { hasAppointment } = {}) {
  const retryNum = row.retry_count;

  // --- RETRY 1: basic email + phone ---
  const basic = await findCase(row.email, row.phone);
  if (basic.caseId) {
    return { caseId: basic.caseId, lookupMethod: basic.lookupMethod };
  }

  // --- RETRY 2+: alt phone formats + GHL enrichment ---
  if (retryNum >= 1) {
    let extraEmails = [];
    let extraPhones = [];

    console.log(`Pending #${row.id}: retry ${retryNum + 1} — enriching contact info from GHL`);
    const enriched = await enrichContactInfo(row.email, row.phone);
    extraEmails = enriched.emails || [];
    extraPhones = enriched.phones || [];

    if (enriched.emails?.length || enriched.phones?.length) {
      const newEmail = enriched.emails?.find((e) => e && e !== row.email);
      const newPhone = enriched.phones?.find((p) => p && p !== row.phone);
      if (newEmail || newPhone) {
        await updatePendingTaskContactInfo(row.id, newEmail || row.email, newPhone || row.phone);
        if (newEmail) row.email = newEmail;
        if (newPhone) row.phone = newPhone;
      }
    }

    const exhaustive = await findCaseExhaustive(row.email, row.phone, extraEmails, extraPhones);
    if (exhaustive.caseId) {
      return { caseId: exhaustive.caseId, lookupMethod: exhaustive.lookupMethod };
    }
  }

  // --- RETRY 3+: AI agent fuzzy match ---
  if (retryNum >= 2) {
    console.log(`Pending #${row.id}: retry ${retryNum + 1} — trying AI agent for contact info`);
    const agentInfo = await findContactInfoViaAgent(
      row.email, row.phone, row.first_name, row.last_name
    );

    if (agentInfo.emails?.length || agentInfo.phones?.length) {
      const agentExhaustive = await findCaseExhaustive(
        row.email, row.phone, agentInfo.emails, agentInfo.phones
      );
      if (agentExhaustive.caseId) {
        return { caseId: agentExhaustive.caseId, lookupMethod: agentExhaustive.lookupMethod };
      }
    }
  }

  // --- RETRY 4: auto-create ---
  if (row.reason === "case_not_found" && retryNum + 1 >= MAX_CASE_NOT_FOUND_RETRIES) {
    console.log(`Pending #${row.id}: all searches exhausted, auto-creating case for ${row.email || row.phone}`);
    const assignment = await getNextOfficer();
    const officer = assignment.officer;

    const createResult = await createCase({
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.email,
      phone: row.phone,
      officerName: officer.name,
    });

    if (!createResult.ok || !createResult.caseId) {
      await incrementRetry(row.id, row.retry_count,
        `Auto-create case failed: ${createResult.errorMessage}`, row.reason);
      results.failed++;
      return null;
    }

    results.autoCreated++;
    console.log(`Pending #${row.id}: case auto-created with CaseID ${createResult.caseId}, officer ${officer.name}`);

    // If appointment data is still missing, we must NOT create a task with a
    // fake DueDate. Park the row as missing_appointment — the retry loop will
    // keep trying GHL REST / MCP / Agent every cron cycle until real data
    // arrives. The case is already created so subsequent cycles skip search.
    if (!hasAppointment) {
      console.log(`Pending #${row.id}: case ${createResult.caseId} created, but no appointment data — deferring task creation to missing_appointment retry loop`);
      await transitionToMissingAppointment(row.id, {
        caseId: createResult.caseId,
        lookupMethod: "auto_created",
      });
      results.retried++;
      return { deferred: true };
    }

    return {
      caseId: createResult.caseId,
      lookupMethod: "auto_created",
      officer,
      method: "auto_created",
    };
  }

  // Not yet exhausted retries
  await incrementRetry(row.id, row.retry_count, "Case still not found in IRS Logics", row.reason);
  results.retried++;
  return null;
}

/**
 * Handle task_failed rows: retry task creation, rotating officers on repeated failures.
 */
async function processTaskFailed(row, results) {
  const caseId = row.case_id;

  const ghlData = await fetchAppointmentFromGhl(row.email, row.phone);
  if (!ghlData.appointmentStart) {
    const agentData = await fetchAppointmentViaAgent(
      row.email, row.phone,
      [row.first_name, row.last_name].filter(Boolean).join(" ") || null,
      null
    );
    if (agentData.appointmentStart) Object.assign(ghlData, agentData);
  }

  // Never retry task creation without real appointment data — defer to the
  // missing_appointment loop so we keep hunting for the real time instead of
  // emitting a task with the webhook processing time.
  if (!ghlData.appointmentStart) {
    console.log(`Pending #${row.id}: task_failed retry has no appointment data — deferring to missing_appointment loop`);
    await transitionToMissingAppointment(row.id, { caseId });
    results.retried++;
    return;
  }

  const parsedStart = parseGhlDate(ghlData.appointmentStart) || ghlData.appointmentStart;
  if (parsedStart && await isDuplicateTask(caseId, parsedStart)) {
    await completePendingTask(row.id);
    results.completed++;
    console.log(`Pending #${row.id}: duplicate task already exists, marking completed`);
    return;
  }

  let officer, assignmentMethod;
  const caseOfficer = await getCaseOfficer(caseId);

  if (row.retry_count === 0 && caseOfficer) {
    officer = caseOfficer;
    assignmentMethod = "case_officer";
  } else {
    const assignment = await getNextOfficer();
    officer = assignment.officer;
    assignmentMethod = "round_robin";
  }

  const normalized = {
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    appointmentTitle: ghlData.appointmentTitle || row.appointment_title,
    appointmentStart: ghlData.appointmentStart,
    appointmentEnd: ghlData.appointmentEnd,
    calendarName: ghlData.calendarName || row.calendar_name,
    aiSummary: row.ai_summary,
    aiTranscript: row.ai_transcript,
  };

  const taskDetails = buildTaskDetails(normalized);

  // Defense in depth — should never fire after the gate above
  if (!canCreateTask(taskDetails)) {
    console.error(`Pending #${row.id}: refusing to create task without real DueDate (task_failed path)`);
    await transitionToMissingAppointment(row.id, { caseId });
    results.retried++;
    return;
  }

  const taskPayload = {
    CaseID: caseId,
    Subject: taskDetails.subject,
    TaskType: 1,
    UserID: [officer.userId],
    PriorityID: 1,
    StatusID: 0,
    DueDate: taskDetails.dueDate,
    Reminder: taskDetails.reminder,
    ...(taskDetails.endDate ? { EndDate: taskDetails.endDate } : {}),
    ...(taskDetails.comments ? { Comments: `[Retry] ${taskDetails.comments}` } : {}),
  };

  const taskResult = await createTask(taskPayload);

  // Store UTC in task_logs for consistent dedup — Pacific is only for IRS Logics API.
  const logStartUtc = parseGhlDate(normalized.appointmentStart) || normalized.appointmentStart;
  const logEndUtc = parseGhlDate(normalized.appointmentEnd) || normalized.appointmentEnd || null;

  await insertTaskLog({
    ...normalized,
    caseId,
    lookupMethod: row.lookup_method,
    taskId: taskResult.taskId,
    taskSubject: taskDetails.subject,
    officerName: officer.name,
    officerUserId: officer.userId,
    assignmentMethod,
    appointmentStart: logStartUtc,
    appointmentEnd: logEndUtc,
    status: taskResult.ok ? "success" : "task_failed",
    errorMessage: taskResult.errorMessage || null,
  });

  if (taskResult.ok) {
    await completePendingTask(row.id);
    results.completed++;
    console.log(`Pending #${row.id}: task_failed retry succeeded (case ${caseId}, officer ${officer.name})`);
    await safeNotifyOfficerTaskCreated({
      caseId,
      taskId: taskResult.taskId,
      taskDetails,
      normalized,
      assignedOfficer: officer,
      officerName: officer.name,
      assignmentMethod,
      sourceTag: "pending retry",
    });
  } else {
    console.log(`Pending #${row.id}: task_failed retry failed again — officer ${officer.name}: ${taskResult.errorMessage}`);
    await incrementRetry(row.id, row.retry_count, taskResult.errorMessage, "task_failed");
    results.failed++;
  }
}

async function processPendingQueue() {
  const pending = await getPendingTasks();
  const results = { processed: 0, completed: 0, retried: 0, failed: 0, autoCreated: 0 };

  for (const row of pending) {
    results.processed++;

    try {
      // --- TASK_FAILED: skip case search, retry task creation with officer rotation ---
      if (row.reason === "task_failed" && row.case_id) {
        await processTaskFailed(row, results);
        continue;
      }

      // --- MISSING_CONTACT_INFO: recover email/phone by name ---
      if (row.reason === "missing_contact_info" && !row.email && !row.phone) {
        const contactName = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
        if (contactName) {
          console.log(`Pending #${row.id}: attempting name-based contact recovery for "${contactName}"`);
          const recovered = await findGhlContactByName(contactName, row.first_name, row.last_name);
          if (recovered?.email || recovered?.phone) {
            console.log(`Pending #${row.id}: recovery succeeded — email=${recovered.email}, phone=${recovered.phone}`);
            row.email = recovered.email || row.email;
            row.phone = recovered.phone || row.phone;
            await updatePendingTaskContactInfo(row.id, recovered.email, recovered.phone);
          } else {
            console.log(`Pending #${row.id}: name recovery failed`);
            await incrementRetry(row.id, row.retry_count, "Name-based contact recovery failed", row.reason);
            results.retried++;
            continue;
          }
        } else {
          await incrementRetry(row.id, row.retry_count, "No name available for recovery", row.reason);
          results.retried++;
          continue;
        }
      }

      // --- APPOINTMENT DATA RECOVERY ---
      const ghlData = await fetchAppointmentFromGhl(row.email, row.phone);

      if (!ghlData.appointmentStart) {
        console.log(`Pending #${row.id}: GHL API failed — trying AI agent`);
        const agentData = await fetchAppointmentViaAgent(
          row.email, row.phone,
          [row.first_name, row.last_name].filter(Boolean).join(" ") || null,
          null
        );
        if (agentData.appointmentStart) Object.assign(ghlData, agentData);
      }

      // Allow case_not_found entries to proceed without appointment data
      const isAutoCreateReady =
        row.reason === "case_not_found" &&
        !row.case_id &&
        row.retry_count + 1 >= MAX_CASE_NOT_FOUND_RETRIES;

      if (!ghlData.appointmentStart && !isAutoCreateReady) {
        await incrementRetry(row.id, row.retry_count, "GHL API + Agent both returned no appointment data", row.reason);
        results.retried++;
        continue;
      }

      // --- ESCALATING CASE SEARCH ---
      let caseId = row.case_id;
      let lookupMethod = row.lookup_method;
      let assignedOfficer = null;
      let assignedMethod = null;

      if (!caseId) {
        const hasAppointment = Boolean(ghlData.appointmentStart);
        const searchResult = await escalatingCaseSearch(row, results, { hasAppointment });
        if (!searchResult) continue; // escalatingCaseSearch already called incrementRetry
        if (searchResult.deferred) continue; // auto-created case but no appointment data yet
        caseId = searchResult.caseId;
        lookupMethod = searchResult.lookupMethod;
        if (searchResult.officer) {
          assignedOfficer = searchResult.officer;
          assignedMethod = searchResult.method;
        }
      }

      // --- DEDUP ---
      const parsedStart = parseGhlDate(ghlData.appointmentStart) || ghlData.appointmentStart;
      if (await isDuplicateTask(caseId, parsedStart)) {
        await completePendingTask(row.id);
        results.completed++;
        console.log(`Pending #${row.id}: duplicate task exists, marking completed`);
        continue;
      }

      // --- BUILD & CREATE TASK ---
      const normalized = {
        firstName: row.first_name,
        lastName: row.last_name,
        email: row.email,
        phone: row.phone,
        appointmentTitle: ghlData.appointmentTitle || row.appointment_title,
        appointmentStart: ghlData.appointmentStart,
        appointmentEnd: ghlData.appointmentEnd,
        calendarName: ghlData.calendarName || row.calendar_name,
        aiSummary: row.ai_summary,
        aiTranscript: row.ai_transcript,
      };

      let officer, assignmentMethod;
      if (assignedOfficer) {
        officer = assignedOfficer;
        assignmentMethod = assignedMethod;
      } else {
        const caseOfficer = await getCaseOfficer(caseId);
        if (caseOfficer) {
          officer = caseOfficer;
          assignmentMethod = "case_officer";
        } else {
          const assignment = await getNextOfficer();
          officer = assignment.officer;
          assignmentMethod = "round_robin";
        }
      }

      const taskDetails = buildTaskDetails(normalized);

      // Defense in depth — should never fire because the gate above + the
      // escalatingCaseSearch deferred branch handle missing appointment data.
      if (!canCreateTask(taskDetails)) {
        console.error(`Pending #${row.id}: refusing to create task without real DueDate (main queue path)`);
        await transitionToMissingAppointment(row.id, { caseId, lookupMethod });
        results.retried++;
        continue;
      }

      let comments = taskDetails.comments || "";
      if (assignmentMethod === "auto_created") {
        comments = `[Auto-Created Case] ${comments}`.trim();
      }

      const taskPayload = {
        CaseID: caseId,
        Subject: taskDetails.subject,
        TaskType: 1,
        UserID: [officer.userId],
        PriorityID: 1,
        StatusID: 0,
        DueDate: taskDetails.dueDate,
        Reminder: taskDetails.reminder,
        ...(taskDetails.endDate ? { EndDate: taskDetails.endDate } : {}),
        ...(comments ? { Comments: comments } : {}),
      };

      const taskResult = await createTask(taskPayload);

      const queueLogStartUtc = parseGhlDate(normalized.appointmentStart) || normalized.appointmentStart;
      const queueLogEndUtc = parseGhlDate(normalized.appointmentEnd) || normalized.appointmentEnd || null;

      await insertTaskLog({
        ...normalized,
        caseId,
        lookupMethod,
        taskId: taskResult.taskId,
        taskSubject: taskDetails.subject,
        officerName: officer.name,
        officerUserId: officer.userId,
        assignmentMethod,
        appointmentStart: queueLogStartUtc,
        appointmentEnd: queueLogEndUtc,
        status: taskResult.ok ? "success" : "task_failed",
        errorMessage: taskResult.errorMessage || null,
      });

      if (taskResult.ok) {
        await completePendingTask(row.id);
        results.completed++;
        console.log(`Pending #${row.id}: task created successfully (case ${caseId})`);
        await safeNotifyOfficerTaskCreated({
          caseId,
          taskId: taskResult.taskId,
          taskDetails,
          normalized,
          assignedOfficer: officer,
          officerName: officer.name,
          assignmentMethod,
          sourceTag: "pending queue",
        });
      } else {
        await incrementRetry(row.id, row.retry_count, taskResult.errorMessage, row.reason);
        results.failed++;
      }
    } catch (error) {
      console.error(`Pending #${row.id} error:`, error.message);
      await incrementRetry(row.id, row.retry_count, error.message, row.reason);
      results.failed++;
    }
  }

  return results;
}

async function safetyNetSweep() {
  const results = { checked: 0, created: 0, skipped: 0 };

  try {
    const [ghlAppointments, recentLogs] = await Promise.all([
      fetchRecentGhlAppointments(),
      getRecentTaskLogs(),
    ]);

    const newAppointments = filterNewAppointments(ghlAppointments, recentLogs);
    results.checked = ghlAppointments.length;

    for (const appt of newAppointments) {
      try {
        const lookup = await findCase(appt.contactEmail, appt.contactPhone);
        if (!lookup.caseId) {
          results.skipped++;
          continue;
        }

        const parsedStart = parseGhlDate(appt.startTime) || appt.startTime;
        if (await isDuplicateTask(lookup.caseId, parsedStart)) {
          results.skipped++;
          continue;
        }

        let officer, assignmentMethod;
        const caseOfficer = await getCaseOfficer(lookup.caseId);
        if (caseOfficer) {
          officer = caseOfficer;
          assignmentMethod = "case_officer";
        } else {
          const assignment = await getNextOfficer();
          officer = assignment.officer;
          assignmentMethod = "round_robin";
        }

        const normalized = {
          email: appt.contactEmail,
          phone: appt.contactPhone,
          appointmentTitle: appt.title,
          appointmentStart: appt.startTime,
          appointmentEnd: appt.endTime,
          calendarName: appt.calendarName,
        };

        const taskDetails = buildTaskDetails(normalized);

        // Defense in depth — safety net sources from GHL directly so dueDate
        // should always be present, but if parsing ever fails we skip rather
        // than send a null DueDate.
        if (!canCreateTask(taskDetails)) {
          console.error(`Safety net: refusing to create task without real DueDate (case ${lookup.caseId})`);
          results.skipped++;
          continue;
        }

        const taskPayload = {
          CaseID: lookup.caseId,
          Subject: taskDetails.subject,
          TaskType: 1,
          UserID: [officer.userId],
          PriorityID: 1,
          StatusID: 0,
          DueDate: taskDetails.dueDate,
          Reminder: taskDetails.reminder,
          ...(taskDetails.endDate ? { EndDate: taskDetails.endDate } : {}),
          ...(taskDetails.comments
            ? { Comments: `[Safety Net] ${taskDetails.comments}` }
            : { Comments: "[Safety Net] Created by cron sweep" }),
        };

        const taskResult = await createTask(taskPayload);

        // Safety net already computed parsedStart above; reuse it for consistent UTC logging.
        const netLogEndUtc = parseGhlDate(normalized.appointmentEnd) || normalized.appointmentEnd || null;

        await insertTaskLog({
          ...normalized,
          caseId: lookup.caseId,
          lookupMethod: lookup.lookupMethod,
          taskId: taskResult.taskId,
          taskSubject: taskDetails.subject,
          officerName: officer.name,
          officerUserId: officer.userId,
          assignmentMethod,
          appointmentStart: parsedStart,
          appointmentEnd: netLogEndUtc,
          status: taskResult.ok ? "success" : "task_failed",
          errorMessage: taskResult.errorMessage || null,
        });

        if (taskResult.ok) {
          results.created++;
          await safeNotifyOfficerTaskCreated({
            caseId: lookup.caseId,
            taskId: taskResult.taskId,
            taskDetails,
            normalized,
            assignedOfficer: officer,
            officerName: officer.name,
            assignmentMethod,
            sourceTag: "safety net",
          });
        }
      } catch (err) {
        console.error("Safety net: failed to process appointment:", err.message);
        results.skipped++;
      }
    }
  } catch (error) {
    console.error("Safety net sweep failed:", error.message);
  }

  return results;
}

export async function GET(request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log("Cron: starting pending queue + safety net sweep");

  const [pendingResults, safetyResults] = await Promise.all([
    processPendingQueue(),
    safetyNetSweep(),
  ]);

  console.log("Cron complete:", { pending: pendingResults, safetyNet: safetyResults });

  return NextResponse.json({
    success: true,
    pending: pendingResults,
    safetyNet: safetyResults,
  });
}
