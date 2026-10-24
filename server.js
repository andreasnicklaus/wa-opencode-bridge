import express from "express";
import fs from "fs";
import path from "path";
import { Agent } from "undici";
import { buildPrompt } from "./prompt.js";
import { isAllowed, isLidJid, phoneFromJid } from "./sender-allowlist.js";
import { hasSendTool, latestAssistantText } from "./opencode-response.js";
import { parseOpenCodeModel } from "./opencode-model.js";

// ---------- Config ----------
const {
  PORT = 3210,
  OPENWA_BASE_URL, // e.g. https://openwa.example.com (without /api/sessions/<uuid>)
  OPENWA_API_KEY,
  OPENWA_SESSION_ID, // WhatsApp session UUID needed for MCP tool calls
  OPENCODE_BASE_URL, // e.g. http://opencode:4096
  OPENCODE_AGENT, // optional named agent/mode to use for this bot
  OPENCODE_MODEL, // optional model override, e.g. "opencode/beam-free"
  OPENCODE_SERVER_USERNAME = "opencode",
  OPENCODE_SERVER_PASSWORD = "", // Basic auth for `opencode serve` when OPENCODE_SERVER_PASSWORD is set there
  KEEP_SESSIONS, // if set, don't delete sessions after each message (for debugging)
  ALLOWED_SENDERS = "", // comma-separated phone numbers (no +, e.g. "4915112345678")
  MAX_MESSAGES_PER_DAY = 100,
  PROMPT_TIMEOUT_MS = 300000,
  STILL_WORKING_AFTER_MS, // if set, send "Still working on it…" after this many ms
  DATA_DIR = "/data",
} = process.env;

if (!OPENWA_BASE_URL || !OPENWA_SESSION_ID || !OPENCODE_BASE_URL) {
  console.error(
    "OPENWA_BASE_URL, OPENWA_SESSION_ID, and OPENCODE_BASE_URL are required",
  );
  process.exit(1);
}

// Optional model override, e.g. "opencode/beam-free" or "provider/model#variant".
let openCodeModel = null;
try {
  openCodeModel = parseOpenCodeModel(OPENCODE_MODEL);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// Construct the full OpenWA session URL from the base domain + session ID
const openwaBase =
  OPENWA_BASE_URL.replace(/\/+$/, "") + `/api/sessions/${OPENWA_SESSION_ID}`;

const opencodeHeaders = () => {
  const headers = { "Content-Type": "application/json" };
  if (OPENCODE_SERVER_PASSWORD) {
    headers.Authorization =
      "Basic " +
      Buffer.from(
        `${OPENCODE_SERVER_USERNAME}:${OPENCODE_SERVER_PASSWORD}`,
      ).toString("base64");
  }
  return headers;
};

const opencodeDispatcher = new Agent({
  headersTimeout: Number(PROMPT_TIMEOUT_MS),
  bodyTimeout: Number(PROMPT_TIMEOUT_MS),
});

const allowlist = ALLOWED_SENDERS.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const logPath = path.join(DATA_DIR, "log.jsonl");
const usagePath = path.join(DATA_DIR, "usage.json");

const log = (...args) => console.log(new Date().toISOString(), ...args);
const truncate = (s, n = 120) => (s.length > n ? s.slice(0, n) + "…" : s);

// ---------- Webhook dedup ----------
// OpenWA delivers webhooks at-least-once: retries reuse the same message
// id, so one message can arrive twice. Ignore repeats within a TTL window.
const seenMessages = new Map();
const DEDUP_TTL_MS = 10 * 60 * 1000;
function isDuplicateMessage(messageId) {
  const now = Date.now();
  if ((seenMessages.get(messageId) || 0) > now) return true;
  seenMessages.set(messageId, now + DEDUP_TTL_MS);
  if (seenMessages.size > 1000) {
    for (const [id, exp] of seenMessages)
      if (exp <= now) seenMessages.delete(id);
  }
  return false;
}

// ---------- Rate limiting (only stateful thing left) ----------
function loadUsage() {
  try {
    return JSON.parse(fs.readFileSync(usagePath, "utf8"));
  } catch {
    return {};
  }
}
function saveUsage(usage) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(usagePath, JSON.stringify(usage));
}
function checkAndBumpRateLimit(sender) {
  const usage = loadUsage();
  const key = `${sender}:${new Date().toISOString().slice(0, 10)}`;
  const count = usage[key] || 0;
  if (count >= Number(MAX_MESSAGES_PER_DAY)) return false;
  usage[key] = count + 1;
  saveUsage(usage);
  return true;
}
function logExchange(entry) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(
    logPath,
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
  );
}

// ---------- OpenWA helpers (used only for reactions + the safety-net fallback) ----------
async function waCall(pathSuffix, body) {
  const res = await fetch(`${openwaBase}${pathSuffix}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENWA_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(
      `OpenWA call ${pathSuffix} failed: ${res.status} ${await res.text()}`,
    );
  }
  return res;
}
const sendText = (chatId, text) =>
  waCall("/messages/send-text", { chatId, text });
const react = (chatId, messageId, emoji) =>
  waCall("/messages/react", { chatId, messageId, emoji });

const PHONE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const phoneCache = new Map();

async function resolveSenderPhone(contactJid) {
  const cached = phoneCache.get(contactJid);
  if (cached && cached.expires > Date.now()) return cached.phone;
  try {
    const res = await fetch(
      `${openwaBase}/contacts/${encodeURIComponent(contactJid)}/phone`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${OPENWA_API_KEY}` },
      },
    );
    if (!res.ok) {
      console.error(
        `OpenWA resolve phone for ${contactJid} failed: ${res.status}`,
      );
      return null;
    }
    const payload = await res.json();
    const phone = payload?.phone || null;
    if (phone) {
      phoneCache.set(contactJid, {
        phone,
        expires: Date.now() + PHONE_CACHE_TTL_MS,
      });
    }
    return phone;
  } catch (err) {
    console.error(`OpenWA resolve phone for ${contactJid} error:`, err);
    return null;
  }
}

// ---------- opencode helpers ----------
// One fresh, throwaway session per incoming message. No chatId->session
// mapping: if the agent needs prior context, it uses its OpenWA MCP tools
// to pull chat history for chatId itself.
async function createSession(chatId) {
  const res = await fetch(`${OPENCODE_BASE_URL}/api/session`, {
    method: "POST",
    headers: opencodeHeaders(),
    body: JSON.stringify({
      title: `wa:${chatId}:${Date.now()}`,
      ...(OPENCODE_AGENT ? { agent: OPENCODE_AGENT } : {}),
      ...(openCodeModel ? { model: openCodeModel } : {}),
    }),
  });
  if (!res.ok) throw new Error(`opencode session create failed: ${res.status}`);
  const session = await res.json();
  return session?.data?.id || session.id;
}

async function deleteSession(sessionId) {
  try {
    const res = await fetch(`${OPENCODE_BASE_URL}/api/session/${sessionId}`, {
      method: "DELETE",
      headers: opencodeHeaders(),
    });
    // 404 means it is already gone, which is all we wanted anyway.
    if (!res.ok && res.status !== 404) {
      console.error(`opencode session delete failed: ${res.status}`);
    }
  } catch (err) {
    // Non-fatal: worst case this session lingers with its "wa:" title
    // prefix, so it's still identifiable for a manual/batch cleanup later.
    console.error(`opencode session delete error for ${sessionId}:`, err);
  }
}

// v2 caps `limit` at 200; longer sessions are walked with cursor.next.
const MESSAGE_PAGE_LIMIT = 200;
const MAX_MESSAGE_PAGES = 10;

async function fetchSessionState(sessionId) {
  const messages = [];
  let url = `${OPENCODE_BASE_URL}/api/session/${sessionId}/message?order=asc&limit=${MESSAGE_PAGE_LIMIT}`;
  for (let page = 0; page < MAX_MESSAGE_PAGES; page += 1) {
    const res = await fetch(url, {
      method: "GET",
      headers: opencodeHeaders(),
      dispatcher: opencodeDispatcher,
    });
    if (!res.ok)
      throw new Error(
        `opencode session messages failed: ${res.status} ${await res.text()}`,
      );
    const body = await res.text();
    if (!body.trim()) break;
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error("opencode session messages returned invalid JSON");
    }
    const batch = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.messages)
        ? payload.messages
        : Array.isArray(payload?.data)
          ? payload.data
          : [];
    messages.push(...batch);
    // `order` and `cursor` must not be combined, so later pages drop it.
    const next = payload?.cursor?.next;
    if (!next || batch.length === 0) break;
    url = `${OPENCODE_BASE_URL}/api/session/${sessionId}/message?limit=${MESSAGE_PAGE_LIMIT}&cursor=${encodeURIComponent(next)}`;
  }
  return {
    messages,
    usedSendTool: hasSendTool(messages),
    sentText: latestAssistantText(messages),
  };
}

// opencode v2 admits a prompt asynchronously: the POST returns as soon as the
// input is durably queued ({data: Session.Inbox.User}) and the agent loop runs
// in the background. Completion is observed with the wait endpoint (204 = loop
// idle, 503 = still busy), then the answer is read from the message list.
const WAIT_POLL_INTERVAL_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAgentIdle(sessionId) {
  const res = await fetch(
    `${OPENCODE_BASE_URL}/api/experimental/session/${sessionId}/wait`,
    {
      method: "POST",
      headers: opencodeHeaders(),
      dispatcher: opencodeDispatcher,
    },
  );
  if (res.status === 204) return true; // agent loop is idle
  if (res.status === 503) return false; // still busy
  throw new Error(`opencode wait failed: ${res.status} ${await res.text()}`);
}

// Poll until the loop reports idle *and* a reply newer than our prompt exists
// (guards against `wait` answering before the loop has actually started).
async function waitForReply(sessionId, promptAt) {
  const startedAt = Date.now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const idle = await waitForAgentIdle(sessionId);
    const state = await fetchSessionState(sessionId);
    const replies = state.messages.filter(
      (message) =>
        (message?.time?.created || 0) >= promptAt &&
        (message?.type === "assistant" || message?.type === "idle"),
    );
    const last = state.messages[state.messages.length - 1];
    if ((idle && replies.length) || last?.type === "idle") {
      return {
        durationMs: Date.now() - startedAt,
        attempts,
        messages: state.messages,
      };
    }
    await sleep(WAIT_POLL_INTERVAL_MS);
  }
}

async function promptOpencode(sessionId, promptText) {
  const start = Date.now();
  const res = await fetch(`${OPENCODE_BASE_URL}/api/session/${sessionId}/prompt`, {
    method: "POST",
    headers: opencodeHeaders(),
    dispatcher: opencodeDispatcher,
    body: JSON.stringify({ text: promptText }),
  });
  if (!res.ok)
    throw new Error(
      `opencode prompt failed: ${res.status} ${await res.text()}`,
    );

  const inbox = await res.json().catch(() => null);
  const promptMessageId = inbox?.data?.id || null;
  const promptAt = inbox?.data?.time?.created || Date.now();

  const { durationMs: waitMs, attempts, messages } = await waitForReply(
    sessionId,
    promptAt,
  );

  // One-shot session, but slice after our prompt anyway so a session kept for
  // debugging (KEEP_SESSIONS) never leaks an older turn's text into this reply.
  let relevant = messages;
  if (promptMessageId) {
    const index = messages.findIndex((m) => m.id === promptMessageId);
    if (index >= 0) relevant = messages.slice(index);
  }
  const parts = relevant
    .filter((m) => m?.type === "assistant")
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  const sentText = latestAssistantText(relevant);
  const usedSendTool = hasSendTool(relevant);

  // A failed run (e.g. upstream model outage) yields no text at all; surface
  // it as an error instead of silently telling the user nothing.
  if (!sentText && !usedSendTool) {
    const idleMessage = [...relevant]
      .reverse()
      .find((message) => message?.type === "idle");
    if (idleMessage?.outcome && idleMessage.outcome !== "succeeded") {
      const failed = [...relevant]
        .reverse()
        .find((message) => message?.type === "assistant" && message.finish === "error");
      throw new Error(
        `opencode run ${idleMessage.outcome}${failed?.error?.message ? `: ${failed.error.message}` : ""}`,
      );
    }
  }

  const noUserVisibleResponse = !sentText && !usedSendTool;
  log("received answer", {
    durationMs: Date.now() - start,
    waitMs,
    waitAttempts: attempts,
    responseKind: "polled",
    parts: parts.map((part) => `${part?.type || "unknown"}`).join(", "),
    usedSendTool,
    noUserVisibleResponse,
  });

  return { sentText, usedSendTool, responseKind: "polled" };
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms),
    ),
  ]);
}

// ---------- Webhook ----------
const app = express();
app.use(express.json());

app.post("/webhook/wa-message", async (req, res) => {
  res.sendStatus(200); // ack immediately, work continues async

  // OpenWA webhooks wrap the message object under `data` (see §6.6 of its
  // API spec); fall back to a flat body so hand-crafted requests still work.
  const msg = req.body?.data || req.body;
  if (!msg || msg.fromMe) return; // never react to our own outgoing messages

  const senderJid = msg.from || msg.sender?.id || "";
  const sender = senderJid.replace(/@.*/, "");
  const chatId = msg.chatId || msg.from;
  const messageId = msg.id;
  const text = msg.body || msg.text;

  // A reply-to carries the quoted message at top level in the webhook's
  // `data` object (and under metadata.quotedMessage for hand-crafted bodies).
  const quoted = msg.quotedMessage || msg.metadata?.quotedMessage || null;
  const quotedMessageId = quoted?.id || null;
  const quotedBody = quoted?.body || null;

  if (!text || !chatId || !messageId) return;

  if (isDuplicateMessage(messageId)) {
    log("webhook duplicate, skipping", {
      chatId,
      messageId,
      text: truncate(text),
    });
    return;
  }

  if (allowlist.length) {
    const phone = isLidJid(senderJid)
      ? await resolveSenderPhone(senderJid)
      : phoneFromJid(senderJid);
    if (!isAllowed(phone, allowlist)) {
      log(
        `Ignoring message from non-allowlisted sender ${sender} (phone ${phone || "unresolved"})`,
      );
      await sendText(
        chatId,
        "Dieser Dienst steht dir leider nicht zur Verfügung. Bitte wende dich an den Betreiber des Dienstes.",
      );
      return;
    }
  }
  if (!checkAndBumpRateLimit(sender)) {
    await sendText(
      chatId,
      "You've hit today's message limit for this bot — try again tomorrow.",
    );
    return;
  }

    log("webhook received", {
      chatId,
      sender,
      messageId,
      quotedBody: quotedBody ? truncate(quotedBody) : null,
      text: truncate(text),
    });
  await react(chatId, messageId, "👀");

  let stillWorkingTimer;
  if (STILL_WORKING_AFTER_MS) {
    stillWorkingTimer = setTimeout(() => {
      sendText(chatId, "Still working on it…");
    }, Number(STILL_WORKING_AFTER_MS));
  }

  let sessionId;
  try {
    sessionId = await createSession(chatId);
    log("session created", {
      chatId,
      sessionId,
      agent: OPENCODE_AGENT || null,
      model: openCodeModel,
    });
    const prompt = buildPrompt({ chatId, sender, text, quotedMessageId, quotedBody });
    const { sentText, usedSendTool, responseKind } = await withTimeout(
      promptOpencode(sessionId, prompt),
      Number(PROMPT_TIMEOUT_MS),
    );
    clearTimeout(stillWorkingTimer);

    if (!usedSendTool && sentText) {
      log(`Agent for ${chatId} didn't use its send tool; sending fallback.`);
      await sendText(chatId, sentText);
    } else if (!usedSendTool) {
      log("Agent produced no user-visible response; suppressing fallback.", {
        chatId,
        responseKind,
      });
    }

    logExchange({
      chatId,
      sender,
      incoming: text,
      quotedMessageId,
      quotedBody,
      reply: sentText || null,
      sessionId,
      usedSendTool,
      responseKind,
      noUserVisibleResponse: !sentText && !usedSendTool,
    });
  } catch (err) {
    clearTimeout(stillWorkingTimer);
    console.error("Error handling message:", err);
    await sendText(chatId, "Sorry, something went wrong processing that.");
    logExchange({
      chatId,
      sender,
      incoming: text,
      error: String(err),
      sessionId,
    });
  } finally {
    await react(chatId, messageId, ""); // clear 👀
    if (sessionId && !KEEP_SESSIONS) {
      await deleteSession(sessionId); // one-shot session, nothing to keep
      log("session deleted", { chatId, sessionId });
    } else if (sessionId) {
      log("session kept (KEEP_SESSIONS)", { chatId, sessionId });
    }
  }
});

app.get("/healthz", (_req, res) => res.send("ok"));

app.listen(PORT, () => console.log(`wa-agent-bridge listening on :${PORT}`));
