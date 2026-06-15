import { NextResponse } from "next/server";
import {
  createCaseActivity,
  createTask,
  findCase,
  getCaseOfficer,
  parseGhlDate,
} from "@/lib/irs-logics";
import { fetchAppointmentFromGhl, findGhlContactByName } from "@/lib/ghl";
import { fetchAppointmentViaAgent } from "@/lib/agent";
import { getNextOfficer, insertTaskLog } from "@/lib/supabase";
import {
  buildCaseActivityDetails,
  buildTaskDetails,
  canCreateTask,
  normalizeWebhookPayload,
} from "@/lib/webhook";
import { buildPendingEntry, insertPendingTask } from "@/lib/pending";
import { isDuplicateTask } from "@/lib/dedup";
import { safeNotifyOfficerTaskCreated } from "@/lib/notify-officer";
import {
  describeAppointmentTime,
  logGhlWebhook,
  summarizeGhlWebhookBody,
} from "@/lib/webhook-debug";

export const dynamic = "force-dynamic";

async function safeInsertTaskLog(entry) {
  try {
    await insertTaskLog(entry);
  } catch (error) {
    console.error("task_logs insert failed:", error);
  }
}

async function safeCreateCaseActivity(activityPayload) {
  try {
    const result = await createCaseActivity(activityPayload);
    if (!result.ok) {
      console.error("case activity creation failed:", result.errorMessage);
    }
  } catch (error) {
    console.error("case activity creation failed:", error);
  }
}

export async function POST(request) {
  let normalized = {};
  let caseId = null;
  let lookupMethod = null;
  let officer = null;
  let assignmentMethod = null;
  let taskId = null;
  let taskDetails = null;

  try {
    const body = await request.json();
    normalized = normalizeWebhookPayload(body);

    logGhlWebhook("raw_payload", summarizeGhlWebhookBody(body));
    logGhlWebhook("normalized", {
      ...normalized,
      appointmentStartTrace: describeAppointmentTime(normalized.appointmentStart),
      appointmentEndTrace: describeAppointmentTime(normalized.appointmentEnd),
    });

    // Recovery: if email/phone are missing, try to find the contact by name in GHL
    if (!normalized.email && !normalized.phone) {
      const contactName = [normalized.firstName, normalized.lastName]
        .filter(Boolean).join(" ").trim();

      if (contactName) {
        console.log(`Missing email/phone — attempting name-based recovery for "${contactName}"`);
        try {
          const recovered = await findGhlContactByName(
            contactName, normalized.firstName, normalized.lastName
          );
          if (recovered?.email || recovered?.phone) {
            console.log(`Name recovery succeeded: email=${recovered.email}, phone=${recovered.phone}`);
            if (recovered.email) normalized.email = recovered.email;
            if (recovered.phone) normalized.phone = recovered.phone;
          }
        } catch (error) {
          console.error("Name-based recovery failed:", error.message);
        }
      }

      // If still no email/phone after recovery attempt, queue or 400
      if (!normalized.email && !normalized.phone) {
        if (contactName) {
          console.log("Name recovery failed — queuing to pending_tasks for retry");
          const pendingEntry = buildPendingEntry(normalized, {
            caseId: null,
            lookupMethod: null,
            reason: "missing_contact_info",
          });
          await insertPendingTask(pendingEntry);

          await safeInsertTaskLog({
            ...normalized,
            status: "error",
            errorMessage: `Missing email/phone — name recovery failed, queued for retry (name: ${contactName})`,
          });

          return NextResponse.json({
            success: true,
            queued: true,
            message: "Missing email/phone — queued for contact info recovery",
          });
        }

        const errorMessage = "Missing email, phone, and name - cannot identify contact";
        await safeInsertTaskLog({
          ...normalized,
          status: "error",
          errorMessage,
        });
        return NextResponse.json({ error: errorMessage }, { status: 400 });
      }
    }

    let lookup = await findCase(normalized.email, normalized.phone);
    caseId = lookup.caseId;
    lookupMethod = lookup.lookupMethod;

    // Retry once after delay — handles race condition where the case is still
    // being created in IRS Logics when the GHL webhook fires simultaneously.
    if (!caseId) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      lookup = await findCase(normalized.email, normalized.phone);
      caseId = lookup.caseId;
      lookupMethod = lookup.lookupMethod;
    }

    if (!caseId) {
      console.log("Case not found after retry — queuing to pending_tasks for delayed retry");

      const pendingEntry = buildPendingEntry(normalized, {
        caseId: null,
        lookupMethod,
        reason: "case_not_found",
      });
      await insertPendingTask(pendingEntry);

      await safeInsertTaskLog({
        ...normalized,
        lookupMethod,
        status: "case_not_found",
        errorMessage: `Case not found — queued for retry (email: ${normalized.email || "-"}, phone: ${normalized.phone || "-"})`,
      });

      return NextResponse.json({
        success: true,
        queued: true,
        message: "Case not found — queued for delayed retry",
      });
    }

    // If the webhook payload is missing appointment times, fetch from GHL API
    if (!normalized.appointmentStart) {
      console.log("Appointment time missing from webhook — fetching from GHL API");
      const ghlData = await fetchAppointmentFromGhl(
        normalized.email,
        normalized.phone
      );

      logGhlWebhook("ghl_api_fallback", {
        recoverySource: ghlData.recoverySource || null,
        appointmentStart: ghlData.appointmentStart || null,
        appointmentEnd: ghlData.appointmentEnd || null,
        appointmentTitle: ghlData.appointmentTitle || null,
        calendarName: ghlData.calendarName || null,
        appointmentStartTrace: describeAppointmentTime(ghlData.appointmentStart),
      });

      if (ghlData.appointmentStart) {
        normalized.appointmentStart = ghlData.appointmentStart;
      }
      if (ghlData.appointmentEnd) {
        normalized.appointmentEnd = ghlData.appointmentEnd;
      }
      if (ghlData.appointmentTitle && !normalized.appointmentTitle) {
        normalized.appointmentTitle = ghlData.appointmentTitle;
      }
      if (ghlData.calendarName && !normalized.calendarName) {
        normalized.calendarName = ghlData.calendarName;
      }
    }

    // AGENT FALLBACK: If GHL API didn't return data, try AI agent with MCP
    if (!normalized.appointmentStart) {
      console.log("GHL API returned no data — trying AI agent with MCP");
      const agentData = await fetchAppointmentViaAgent(
        normalized.email,
        normalized.phone,
        [normalized.firstName, normalized.lastName].filter(Boolean).join(" ") || null,
        null
      );
      if (agentData.appointmentStart) normalized.appointmentStart = agentData.appointmentStart;
      if (agentData.appointmentEnd) normalized.appointmentEnd = agentData.appointmentEnd;
      if (agentData.appointmentTitle && !normalized.appointmentTitle) normalized.appointmentTitle = agentData.appointmentTitle;
      if (agentData.calendarName && !normalized.calendarName) normalized.calendarName = agentData.calendarName;
    }

    // GATE: If we STILL don't have appointment data after GHL fallback,
    // queue to pending_tasks instead of creating a task with fake times
    if (!normalized.appointmentStart) {
      console.log("Still no appointment data after GHL fallback — queuing to pending_tasks");

      const pendingEntry = buildPendingEntry(normalized, { caseId, lookupMethod, reason: "missing_appointment" });
      await insertPendingTask(pendingEntry);

      await safeInsertTaskLog({
        ...normalized,
        caseId,
        lookupMethod,
        status: "pending_appointment",
        errorMessage: "Appointment data missing — queued for retry via cron",
      });

      return NextResponse.json({
        success: true,
        queued: true,
        caseId,
        message: "Appointment data missing — queued for processing. Task will be created when appointment details are available.",
      });
    }

    // Canonical UTC ISO for dedup + task_logs (Pacific conversion happens only for IRS Logics API).
    // Storing UTC in task_logs keeps dedup stable and makes time-range queries consistent.
    const parsedStartUtc = parseGhlDate(normalized.appointmentStart) || normalized.appointmentStart;
    const parsedEndUtc = parseGhlDate(normalized.appointmentEnd) || normalized.appointmentEnd || null;

    // DEDUP: Check if we already created a task for this case + appointment time
    if (await isDuplicateTask(caseId, parsedStartUtc)) {
      console.log(`Duplicate task detected for case ${caseId} at ${parsedStartUtc} — skipping`);
      return NextResponse.json({
        success: true,
        duplicate: true,
        caseId,
        message: "Task already exists for this appointment",
      });
    }

    // Priority: use the case's assigned officer first, fall back to round-robin
    const caseOfficer = await getCaseOfficer(caseId);
    if (caseOfficer) {
      officer = caseOfficer;
      assignmentMethod = "case_officer";
    } else {
      const assignment = await getNextOfficer();
      officer = assignment.officer;
      assignmentMethod = "round_robin";
    }

    taskDetails = buildTaskDetails(normalized);

    logGhlWebhook("task_build", {
      caseId,
      lookupMethod,
      appointmentStartTrace: describeAppointmentTime(normalized.appointmentStart),
      taskSubject: taskDetails.subject,
      dueDateUtc: taskDetails.dueDate,
      dueDatePacific: taskDetails.dueDate
        ? new Date(taskDetails.dueDate).toLocaleString("en-US", {
            timeZone: "America/Los_Angeles",
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
            timeZoneName: "short",
          })
        : null,
    });

    // Defense in depth — if parseGhlDate couldn't parse the raw string even
    // though it was non-empty, defer to the pending queue rather than send a
    // null DueDate (which IRS Logics rejects, and previously would have
    // silently fallen back to the webhook processing time).
    if (!canCreateTask(taskDetails)) {
      console.error(`Webhook: refusing to create task with unparseable appointmentStart for case ${caseId}`);
      const pendingEntry = buildPendingEntry(normalized, { caseId, lookupMethod, reason: "missing_appointment" });
      await insertPendingTask(pendingEntry);

      await safeInsertTaskLog({
        ...normalized,
        caseId,
        lookupMethod,
        status: "pending_appointment",
        errorMessage: "Appointment time unparseable — queued for retry via cron",
      });

      return NextResponse.json({
        success: true,
        queued: true,
        caseId,
        message: "Appointment time unparseable — queued for processing.",
      });
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
      ...(taskDetails.comments ? { Comments: taskDetails.comments } : {}),
    };

    logGhlWebhook("irs_task_payload", taskPayload);

    const taskResult = await createTask(taskPayload);
    taskId = taskResult.taskId;

    if (!taskResult.ok) {
      // Queue to pending for retry instead of dead-ending
      const pendingEntry = buildPendingEntry(normalized, {
        caseId,
        lookupMethod,
        reason: "task_failed",
      });
      pendingEntry.error_message = taskResult.errorMessage;

      try {
        await insertPendingTask(pendingEntry);
        console.log(`Task creation failed — queued for retry (case ${caseId}, officer ${officer.name}): ${taskResult.errorMessage}`);
      } catch (pendingError) {
        console.error("Failed to queue task_failed to pending:", pendingError.message);
      }

      await safeInsertTaskLog({
        ...normalized,
        caseId,
        lookupMethod,
        taskId,
        taskSubject: taskDetails.subject,
        officerName: officer.name,
        officerUserId: officer.userId,
        assignmentMethod,
        appointmentStart: parsedStartUtc,
        appointmentEnd: parsedEndUtc,
        status: "task_failed",
        errorMessage: taskResult.errorMessage,
      });

      return NextResponse.json({
        success: true,
        queued: true,
        caseId,
        message: `Task creation failed — queued for retry: ${taskResult.errorMessage}`,
      });
    }

    await safeCreateCaseActivity({
      CaseID: caseId,
      ...buildCaseActivityDetails(normalized, {
        taskId,
        assignedTo: officer.name,
        assignmentMethod,
        taskSubject: taskDetails.subject,
      }),
    });

    await safeInsertTaskLog({
      ...normalized,
      caseId,
      lookupMethod,
      taskId,
      taskSubject: taskDetails.subject,
      officerName: officer.name,
      officerUserId: officer.userId,
      assignmentMethod,
      appointmentStart: parsedStartUtc,
      appointmentEnd: parsedEndUtc,
      status: "success",
    });

    await safeNotifyOfficerTaskCreated({
      caseId,
      taskId,
      taskDetails,
      normalized,
      assignedOfficer: officer,
      officerName: officer.name,
      assignmentMethod,
      sourceTag: "GHL webhook",
    });

    return NextResponse.json({
      success: true,
      caseId,
      taskId,
      assignedTo: officer.name,
      assignmentMethod,
      message: taskResult.result?.Message || taskResult.result?.message || null,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    await safeInsertTaskLog({
      ...normalized,
      caseId,
      lookupMethod,
      taskId,
      taskSubject: taskDetails?.subject,
      officerName: officer?.name,
      officerUserId: officer?.userId,
      assignmentMethod,
      appointmentStart: parseGhlDate(normalized?.appointmentStart) || normalized?.appointmentStart,
      appointmentEnd: parseGhlDate(normalized?.appointmentEnd) || normalized?.appointmentEnd || null,
      status: "error",
      errorMessage,
    });

    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
