const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export function isGmailConfigured(env = process.env) {
  return Boolean(
    env.GMAIL_CLIENT_ID &&
      env.GMAIL_CLIENT_SECRET &&
      env.GMAIL_REFRESH_TOKEN &&
      env.GMAIL_USER
  );
}

export async function refreshGmailAccessToken(env = process.env, fetchImpl = fetch) {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(
      payload.error_description || payload.error || `Gmail token refresh failed (${response.status})`
    );
  }

  return payload.access_token;
}

export function parseEmailList(raw) {
  if (raw === undefined || raw === null || raw === "false" || raw === "") return [];
  return String(raw)
    .split(/[,;]+/)
    .map((email) => email.trim())
    .filter((email) => email.includes("@"));
}

export function resolveGmailNotifyBcc(env = process.env, to) {
  const configured = env.GMAIL_NOTIFY_BCC;
  if (configured === "false" || configured === "") return undefined;

  const bcc = (configured || "no-reply@valortaxrelief.com").trim();
  if (!bcc) return undefined;
  if (to && bcc.toLowerCase() === String(to).trim().toLowerCase()) return undefined;
  return bcc;
}

/** Additional manager emails (Cc) on appointment notifications. */
export function resolveGmailNotifyCc(env = process.env, { to, bcc } = {}) {
  const exclude = new Set(
    [to, bcc, resolveGmailNotifyBcc(env, to)]
      .filter(Boolean)
      .map((email) => String(email).trim().toLowerCase())
  );

  return parseEmailList(env.GMAIL_NOTIFY_MANAGERS).filter(
    (email) => !exclude.has(email.toLowerCase())
  );
}

export function encodeMimeHeader(value) {
  if (value === undefined || value === null) return "";
  const text = String(value);
  if (/^[\x00-\x7F]*$/.test(text)) return text;
  const encoded = Buffer.from(text, "utf8").toString("base64");
  return `=?UTF-8?B?${encoded}?=`;
}

export function encodeGmailRawMessage({ from, to, cc, bcc, subject, text, html }) {
  let body;
  let contentType;

  if (html) {
    const boundary = `valor_${Date.now().toString(36)}`;
    contentType = `multipart/alternative; boundary="${boundary}"`;
    body = [
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 7bit",
      "",
      text || "",
      "",
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: 7bit",
      "",
      html,
      "",
      `--${boundary}--`,
    ].join("\r\n");
  } else {
    contentType = "text/plain; charset=utf-8";
    body = text || "";
  }

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
  ];
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  headers.push(
    `Subject: ${encodeMimeHeader(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: ${contentType}`,
    "",
    body,
  );

  const message = headers.join("\r\n");

  return Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function sendGmail(
  { to, cc, bcc, subject, text, html },
  { env = process.env, fetchImpl = fetch } = {}
) {
  if (!isGmailConfigured(env)) {
    throw new Error("Gmail is not configured");
  }

  const resolvedBcc = bcc === undefined ? resolveGmailNotifyBcc(env, to) : bcc || undefined;
  const resolvedCc =
    cc === undefined
      ? resolveGmailNotifyCc(env, { to, bcc: resolvedBcc })
      : parseEmailList(cc);
  const ccHeader = resolvedCc.length ? resolvedCc.join(", ") : undefined;

  const accessToken = await refreshGmailAccessToken(env, fetchImpl);
  const raw = encodeGmailRawMessage({
    from: env.GMAIL_USER,
    to,
    cc: ccHeader,
    bcc: resolvedBcc,
    subject,
    text,
    html,
  });

  const response = await fetchImpl(GMAIL_SEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      payload.error?.message || payload.error_description || `Gmail send failed (${response.status})`
    );
  }

  return { ...payload, bcc: resolvedBcc || null, cc: resolvedCc };
}
