import assert from "node:assert/strict";

import {
  encodeGmailRawMessage,
  isGmailConfigured,
  parseEmailList,
  refreshGmailAccessToken,
  resolveGmailNotifyCc,
  sendGmail,
} from "../../lib/gmail.js";

function run(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function runAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

const env = {
  GMAIL_CLIENT_ID: "client-id",
  GMAIL_CLIENT_SECRET: "client-secret",
  GMAIL_REFRESH_TOKEN: "refresh-token",
  GMAIL_USER: "no-reply@example.com",
};

run("isGmailConfigured returns false when vars missing", () => {
  assert.equal(isGmailConfigured({}), false);
  assert.equal(isGmailConfigured(env), true);
});

run("encodeGmailRawMessage produces base64url", () => {
  const raw = encodeGmailRawMessage({
    from: "no-reply@example.com",
    to: "officer@example.com",
    subject: "Test",
    text: "Hello",
  });
  assert.ok(raw.length > 10);
  assert.ok(!raw.includes("+"));
  assert.ok(!raw.includes("/"));
});

await runAsync("refreshGmailAccessToken exchanges refresh token", async () => {
  const token = await refreshGmailAccessToken(env, async () => ({
    ok: true,
    json: async () => ({ access_token: "access-123" }),
  }));
  assert.equal(token, "access-123");
});

run("encodeGmailRawMessage includes Bcc header when provided", () => {
  const raw = encodeGmailRawMessage({
    from: "no-reply@example.com",
    to: "officer@example.com",
    bcc: "no-reply@valortaxrelief.com",
    subject: "Test",
    text: "Hello",
  });
  const decoded = Buffer.from(
    raw.replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  ).toString("utf8");
  assert.ok(decoded.includes("Bcc: no-reply@valortaxrelief.com"));
});

run("parseEmailList splits comma-separated manager emails", () => {
  assert.deepEqual(parseEmailList("a@x.com, b@x.com"), ["a@x.com", "b@x.com"]);
  assert.deepEqual(parseEmailList(""), []);
  assert.deepEqual(parseEmailList("false"), []);
});

run("resolveGmailNotifyCc excludes officer and bcc duplicates", () => {
  const cc = resolveGmailNotifyCc(
    {
      GMAIL_NOTIFY_MANAGERS: "manager@valortaxrelief.com,officer@example.com",
      GMAIL_NOTIFY_BCC: "no-reply@valortaxrelief.com",
    },
    { to: "officer@example.com", bcc: "no-reply@valortaxrelief.com" }
  );
  assert.deepEqual(cc, ["manager@valortaxrelief.com"]);
});

run("encodeGmailRawMessage includes Cc header when provided", () => {
  const raw = encodeGmailRawMessage({
    from: "no-reply@example.com",
    to: "officer@example.com",
    cc: "manager@valortaxrelief.com",
    subject: "Test",
    text: "Hello",
  });
  const decoded = Buffer.from(
    raw.replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  ).toString("utf8");
  assert.ok(decoded.includes("Cc: manager@valortaxrelief.com"));
});

await runAsync("sendGmail adds manager Cc from GMAIL_NOTIFY_MANAGERS", async () => {
  let capturedBody;
  await sendGmail(
    { to: "officer@example.com", subject: "Task", text: "Body" },
    {
      env: {
        ...env,
        GMAIL_NOTIFY_MANAGERS: "manager1@valortaxrelief.com,manager2@valortaxrelief.com",
        GMAIL_NOTIFY_BCC: "false",
      },
      fetchImpl: async (url, init) => {
        if (String(url).includes("oauth2.googleapis.com")) {
          return { ok: true, json: async () => ({ access_token: "tok" }) };
        }
        capturedBody = JSON.parse(init.body).raw;
        return { ok: true, json: async () => ({ id: "msg-1" }) };
      },
    }
  );
  const decoded = Buffer.from(
    capturedBody.replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  ).toString("utf8");
  assert.ok(decoded.includes("Cc: manager1@valortaxrelief.com, manager2@valortaxrelief.com"));
});

await runAsync("sendGmail adds default Bcc copy address", async () => {
  let capturedBody;
  await sendGmail(
    { to: "officer@example.com", subject: "Task", text: "Body", html: "<p>Hi</p>" },
    {
      env,
      fetchImpl: async (url, init) => {
        if (String(url).includes("oauth2.googleapis.com")) {
          return { ok: true, json: async () => ({ access_token: "tok" }) };
        }
        capturedBody = JSON.parse(init.body).raw;
        return { ok: true, json: async () => ({ id: "msg-1" }) };
      },
    }
  );
  const decoded = Buffer.from(
    capturedBody.replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  ).toString("utf8");
  assert.ok(decoded.includes("Bcc: no-reply@valortaxrelief.com"));
});

await runAsync("sendGmail posts to Gmail API with bearer token", async () => {
  let capturedBody;
  const result = await sendGmail(
    { to: "officer@example.com", subject: "Task", text: "Body", html: "<p>Hi</p>" },
    {
      env,
      fetchImpl: async (url, init) => {
        if (String(url).includes("oauth2.googleapis.com")) {
          return { ok: true, json: async () => ({ access_token: "tok" }) };
        }
        capturedBody = JSON.parse(init.body).raw;
        return { ok: true, json: async () => ({ id: "msg-1" }) };
      },
    }
  );
  assert.equal(result.id, "msg-1");
  const decoded = Buffer.from(
    capturedBody.replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  ).toString("utf8");
  assert.ok(decoded.includes("multipart/alternative"));
  assert.ok(decoded.includes("text/html"));
  assert.ok(decoded.includes("<p>Hi</p>"));
});
