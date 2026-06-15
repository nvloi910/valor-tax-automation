import assert from "node:assert/strict";

import { fetchAppointmentFromGhlWithProviders, scoreNameMatch } from "../../lib/ghl.js";

async function run(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

await run("fetchAppointmentFromGhlWithProviders returns REST data first", async () => {
  const result = await fetchAppointmentFromGhlWithProviders(
    { email: "jane@example.com", phone: "(555)123-4567" },
    {
      restFetcher: async () => ({
        appointmentStart: "2026-04-02 12:00:00",
        appointmentTitle: "REST Consult",
      }),
      mcpFetcher: async () => ({
        appointmentStart: "2026-04-03 12:00:00",
        appointmentTitle: "MCP Consult",
      }),
    }
  );

  assert.equal(result.appointmentStart, "2026-04-02T19:00:00.000Z");
  assert.equal(result.recoverySource, "rest");
});

await run("fetchAppointmentFromGhlWithProviders falls back to MCP when REST is empty", async () => {
  const result = await fetchAppointmentFromGhlWithProviders(
    { email: "jane@example.com", phone: "(555)123-4567" },
    {
      restFetcher: async () => ({}),
      mcpFetcher: async () => ({
        appointmentStart: "2026-04-03 12:00:00",
        appointmentTitle: "MCP Consult",
      }),
    }
  );

  assert.equal(result.appointmentStart, "2026-04-03T19:00:00.000Z");
  assert.equal(result.recoverySource, "mcp");
});

await run("fetchAppointmentFromGhlWithProviders falls back to MCP after REST errors", async () => {
  const result = await fetchAppointmentFromGhlWithProviders(
    { email: "jane@example.com", phone: "(555)123-4567" },
    {
      restFetcher: async () => {
        throw new Error("401");
      },
      mcpFetcher: async () => ({
        appointmentStart: "2026-04-03 12:00:00",
        appointmentTitle: "MCP Consult",
      }),
    }
  );

  assert.equal(result.appointmentTitle, "MCP Consult");
  assert.equal(result.recoverySource, "mcp");
});

await run("scoreNameMatch returns 3 for exact first+last match", async () => {
  const score = scoreNameMatch(
    { firstName: "Mark", lastName: "Geoff" },
    "Mark", "Geoff"
  );
  assert.equal(score, 3);
});

await run("scoreNameMatch is case-insensitive", async () => {
  const score = scoreNameMatch(
    { firstName: "mark", lastName: "geoff" },
    "Mark", "Geoff"
  );
  assert.equal(score, 3);
});

await run("scoreNameMatch returns 2 for last name only match", async () => {
  const score = scoreNameMatch(
    { firstName: "John", lastName: "Geoff" },
    "Mark", "Geoff"
  );
  assert.equal(score, 2);
});

await run("scoreNameMatch returns 1 for first name only match", async () => {
  const score = scoreNameMatch(
    { firstName: "Mark", lastName: "Smith" },
    "Mark", "Geoff"
  );
  assert.equal(score, 1);
});

await run("scoreNameMatch returns 0 for no match", async () => {
  const score = scoreNameMatch(
    { firstName: "Jane", lastName: "Doe" },
    "Mark", "Geoff"
  );
  assert.equal(score, 0);
});

await run("scoreNameMatch handles first_name/last_name fields", async () => {
  const score = scoreNameMatch(
    { first_name: "Mark", last_name: "Geoff" },
    "Mark", "Geoff"
  );
  assert.equal(score, 3);
});
