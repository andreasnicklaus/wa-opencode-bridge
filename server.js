import express from "express";
import fs from "fs";
import path from "path";

// ---------- Config ----------
const {
  PORT = 3210,
  OPENWA_BASE_URL,          // e.g. https://openwa.example.com (without /api/sessions/<uuid>)
  OPENWA_API_KEY,
  OPENWA_SESSION_ID,        // WhatsApp session UUID needed for MCP tool calls
  OPENCODE_BASE_URL,        // e.g. http://opencode:4096
  OPENCODE_AGENT,           // optional named agent/mode to use for this bot
  OPENCODE_SERVER_USERNAME = "opencode",
  OPENCODE_SERVER_PASSWORD = "", // Basic auth for `opencode serve` when OPENCODE_SERVER_PASSWORD is set there
  KEEP_SESSIONS,            // if set, don't delete sessions after each message (for debugging)
  ALLOWED_SENDERS = "",     // comma-separated phone numbers (no +, e.g. "4915112345678")
  MAX_MESSAGES_PER_DAY = 100,
  PROMPT_TIMEOUT_MS = 300000,
  STILL_WORKING_AFTER_MS,  // if set, send "Still working on it…" after this many ms
  DATA_DIR = "/data",
} = process.env;

if (!OPENWA_BASE_URL || !OPENWA_SESSION_ID || !OPENCODE_BASE_URL) {
  console.error("OPENWA_BASE_URL, OPENWA_SESSION_ID, and OPENCODE_BASE_URL are required");
  process.exit(1);
}

// Construct the full OpenWA session URL from the base domain + session ID
const openwaBase = OPENWA_BASE_URL.replace(/\/+$/, "") + `/api/sessions/${OPENWA_SESSION_ID}`;

const opencodeHeaders = () => {
  const headers = { "Content-Type": "application/json" };
  if (OPENCODE_SERVER_PASSWORD) {
    headers.Authorization =
      "Basic " + Buffer.from(`${OPENCODE_SERVER_USERNAME}:${OPENCODE_SERVER_PASSWORD}`).toString("base64");
  }
  return headers;
};

const allowlist = ALLOWED_SENDERS.split(",").map(s => s.trim()).filter(Boolean);
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
    for (const [id, exp] of seenMessages) if (exp <= now) seenMessages.delete(id);
  }
  return false;
}

// ---------- Rate limiting (only stateful thing left) ----------
function loadUsage() {
  try { return JSON.parse(fs.readFileSync(usagePath, "utf8")); } catch { return {}; }
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
  fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
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
    console.error(`OpenWA call ${pathSuffix} failed: ${res.status} ${await res.text()}`);
  }
  return res;
}
const sendText = (chatId, text) => waCall("/messages/send-text", { chatId, text });
const react = (chatId, messageId, emoji) =>
  waCall("/messages/react", { chatId, messageId, emoji });

// ---------- opencode helpers ----------
// One fresh, throwaway session per incoming message. No chatId->session
// mapping: if the agent needs prior context, it uses its OpenWA MCP tools
// to pull chat history for chatId itself.
async function createSession(chatId) {
  const res = await fetch(`${OPENCODE_BASE_URL}/session`, {
    method: "POST",
    headers: opencodeHeaders(),
    body: JSON.stringify({ title: `wa:${chatId}:${Date.now()}` }),
  });
  if (!res.ok) throw new Error(`opencode session create failed: ${res.status}`);
  const session = await res.json();
  return session.id;
}

async function deleteSession(sessionId) {
  try {
    const res = await fetch(`${OPENCODE_BASE_URL}/session/${sessionId}`, { method: "DELETE", headers: opencodeHeaders() });
    if (!res.ok) console.error(`opencode session delete failed: ${res.status}`);
  } catch (err) {
    // Non-fatal: worst case this session lingers with its "wa:" title
    // prefix, so it's still identifiable for a manual/batch cleanup later.
    console.error(`opencode session delete error for ${sessionId}:`, err);
  }
}

function buildPrompt({ chatId, sender, text }) {
  const sessionId = OPENWA_SESSION_ID;
  return [
    `You are the WhatsApp assistant. An incoming WhatsApp message needs a reply.`,
    ``,
    `## Context`,
    `- WhatsApp session ID (sessionId): ${sessionId}  ← USE THIS for all WhatsApp MCP tool calls`,
    `- Chat ID (chatId): ${chatId}`,
    `- Sender: ${sender}`,
    `- Message: ${text}`,
    ``,
    `## Available WhatsApp MCP tools`,
    `All tools require sessionId = "${sessionId}" as shown above.`,
    `- whatsapp_MessageHistory — Fetch recent messages in a chat. Params: sessionId="${sessionId}", chatId="${chatId}", limit=20`,
    `- whatsapp_MessageSendText — Send a text reply. Params: sessionId="${sessionId}", chatId="${chatId}", text="your reply"`,
    `- whatsapp_MessageList — List persisted messages from local DB. Params: sessionId="${sessionId}", chatId="${chatId}"`,
    `- whatsapp_SessionFindOne — Get session info. Params: sessionId="${sessionId}"`,
    `- whatsapp_SessionGetChats — List recent chats. Params: sessionId="${sessionId}"`,
    ``,
    `## Work order (follow exactly)`,
    ``,
    `Step 1 — Get context:`,
    `Call whatsapp_MessageHistory with sessionId="${sessionId}" and chatId="${chatId}" to read recent messages. Use this to understand what the user is referring to.`,
    ``,
    `Step 2 — Compose your reply:`,
    `Based on the message and chat history, write a helpful response.`,
    ``,
    `Step 3 — Send the reply:`,
    `Call whatsapp_MessageSendText with sessionId="${sessionId}", chatId="${chatId}", and text="your reply message".`,
    ``,
    `Step 4 — Confirm:`,
    `After sending, respond with EXACTLY the text you sent (the text parameter from Step 3). Nothing else — no labels, no prefixes. This text is logged for the system.`,
    ``,
    `## CRITICAL RULES`,
    `- NEVER use "SessionFindAll" — you already have the session ID: ${sessionId}`,
    `- NEVER use "MessageHistory" or "MessageList" without passing sessionId="${sessionId}"`,
    `- NEVER skip Step 1 — always fetch chat history first for context`,
    `- The chatId "${chatId}" is the WhatsApp JID — pass it as-is to all tools`,
  ].join("\n");
}

// The POST /message response only carries the final assistant message's
// parts (step-start/text/step-finish) — tool calls live in separate
// assistant messages that the streaming endpoint never returns. List the
// whole session after the prompt completes and scan every part for a
// WhatsApp send-tool invocation; that is the only reliable place to see it.
async function fetchSessionToolUses(sessionId) {
  const res = await fetch(`${OPENCODE_BASE_URL}/session/${sessionId}/message`, {
    method: "GET",
    headers: opencodeHeaders(),
  });
  if (!res.ok) throw new Error(`opencode session messages failed: ${res.status} ${await res.text()}`);
  const messages = await res.json();
  const toolNameOf = p => p?.tool || p?.name || p?.state?.tool || p?.state?.input?.tool || p?.toolName || "";
  return (messages || []).some(m =>
    (m?.parts || []).some(p => p?.type === "tool" && /send.?text|whatsapp/i.test(toolNameOf(p)))
  );
}

async function promptOpencode(sessionId, promptText) {
  const start = Date.now();
  const res = await fetch(`${OPENCODE_BASE_URL}/session/${sessionId}/message`, {
    method: "POST",
    headers: opencodeHeaders(),
    body: JSON.stringify({
      parts: [{ type: "text", text: promptText }],
      ...(OPENCODE_AGENT ? { agent: OPENCODE_AGENT } : {}),
    }),
  });
  if (!res.ok) throw new Error(`opencode prompt failed: ${res.status} ${await res.text()}`);
  const result = await res.json();
  const parts = result?.parts || result?.message?.parts || [];
  const sentText = parts
    .filter(p => p.type === "text")
    .map(p => p.text)
    .join("\n")
    .trim();

  // Tool parts carry their name in different places depending on opencode
  // server version (top-level `tool`, `name`, or nested under `state`).
  const toolNameOf = p => p?.tool || p?.name || p?.state?.tool || p?.state?.input?.tool || p?.toolName || "";

  // Did the agent actually call the WhatsApp send tool? Used as a sanity
  // check — if not, we fall back to sending the text ourselves so the
  // user isn't left hanging on a model that forgot to use its tools.
  let usedSendTool = parts.some(
    p => p.type === "tool" && /send.?text|whatsapp/i.test(toolNameOf(p))
  );
  if (!usedSendTool) {
    try {
      usedSendTool = await fetchSessionToolUses(sessionId);
    } catch (err) {
      console.error("session tool scan failed:", err);
    }
  }

  log("received answer", {
    durationMs: Date.now() - start,
    parts: parts.map(p => `${p.type}:${p.type === "tool" ? toolNameOf(p) : ""}`).join(", "),
    usedSendTool,
  });

  return { sentText: sentText || "(agent returned no text)", usedSendTool };
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
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

  const sender = (msg.from || msg.sender?.id || "").replace(/@.*/, "");
  const chatId = msg.chatId || msg.from;
  const messageId = msg.id;
  const text = msg.body || msg.text;

  if (!text || !chatId || !messageId) return;

  if (isDuplicateMessage(messageId)) {
    log("webhook duplicate, skipping", { chatId, messageId, text: truncate(text) });
    return;
  }

  if (allowlist.length && !allowlist.includes(sender)) {
    log(`Ignoring message from non-allowlisted sender ${sender}`);
    return;
  }
  if (!checkAndBumpRateLimit(sender)) {
    await sendText(chatId, "You've hit today's message limit for this bot — try again tomorrow.");
    return;
  }

  log("webhook received", { chatId, sender, messageId, text: truncate(text) });
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
    log("session created", { chatId, sessionId });
    const prompt = buildPrompt({ chatId, sender, text });
    const { sentText, usedSendTool } = await withTimeout(
      promptOpencode(sessionId, prompt),
      Number(PROMPT_TIMEOUT_MS)
    );
    clearTimeout(stillWorkingTimer);

    if (!usedSendTool) {
      // Safety net: agent produced text but never actually messaged the
      // user via MCP — send it ourselves rather than silently dropping it.
      log(`Agent for ${chatId} didn't use its send tool; sending fallback.`);
      await sendText(chatId, sentText);
    }

    logExchange({ chatId, sender, incoming: text, reply: sentText, sessionId, usedSendTool });
  } catch (err) {
    clearTimeout(stillWorkingTimer);
    console.error("Error handling message:", err);
    await sendText(chatId, "Sorry, something went wrong processing that.");
    logExchange({ chatId, sender, incoming: text, error: String(err), sessionId });
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
