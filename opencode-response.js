function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function messageParts(value) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.parts)) return value.parts;
  // opencode v2 flat assistant message: {type:"assistant", content:[...]}
  if (Array.isArray(value.content)) return value.content;
  if (value.message && value.message !== value) return messageParts(value.message);
  if (value.data && value.data !== value) return messageParts(value.data);
  if (value.type === "text" || value.type === "reasoning" || value.type === "tool") {
    return [value];
  }
  return [];
}

function allParts(value) {
  if (Array.isArray(value)) return value.flatMap((item) => allParts(item));
  return messageParts(value);
}

function messageRole(value) {
  if (value?.info?.role || value?.message?.role || value?.role) {
    return value.info?.role || value.message?.role || value.role;
  }
  // opencode v2 flat messages carry the role in `type`
  // ({type:"user"|"assistant"|"system"|...}).
  if (typeof value?.type === "string") return value.type;
  return value?.info?.type || "";
}

function toolNameOf(part) {
  return (
    part?.tool ||
    part?.name ||
    part?.state?.tool ||
    part?.state?.input?.tool ||
    part?.toolName ||
    ""
  );
}

export function responseParts(value) {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const parts = responseParts(value[index]);
      if (parts.length) return parts;
    }
    return [];
  }
  return messageParts(value);
}

export function textFromParts(parts) {
  return asArray(parts)
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function responseText(value) {
  return textFromParts(responseParts(value));
}

// Matches an actual MessageSendText call, e.g. code passed to an
// `execute` tool: `tools.whatsapp.MessageSendText({...})`. Deliberately
// precise so search queries like `search({query: "whatsapp send text"})`
// don't count as sending.
const SEND_CALL_PATTERN = /whatsapp\.MessageSendText|MessageSendText\s*\(/;

function toolPartSends(part) {
  if (part?.type !== "tool") return false;
  if (/send.?text|whatsapp/i.test(toolNameOf(part))) return true;
  const input = part?.state?.input;
  if (input == null) return false;
  try {
    return SEND_CALL_PATTERN.test(
      typeof input === "string" ? input : JSON.stringify(input),
    );
  } catch {
    return false;
  }
}

export function hasSendTool(value) {
  return allParts(value).some((part) => toolPartSends(part));
}

export function latestAssistantText(messages) {
  for (let index = asArray(messages).length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const role = messageRole(message);
    if (role && role !== "assistant") continue;
    const text = textFromParts(messageParts(message));
    if (text) return text;
  }
  return "";
}

export function isControlOnlyResponse(value) {
  const parts = responseParts(value);
  return parts.length > 0 && !textFromParts(parts);
}

export function parsePromptBody(body) {
  const trimmed = String(body ?? "")
    .replace(/^\uFEFF/, "")
    .trim();
  if (!trimmed) return { kind: "empty", payload: null };

  const lines = trimmed.split(/\r?\n/);
  if (lines.some((line) => line.startsWith("data:"))) {
    const payloads = [];
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        payloads.push(JSON.parse(data));
      } catch {
        continue;
      }
    }
    if (!payloads.length) return { kind: "stream", payload: null };
    const payload = [...payloads]
      .reverse()
      .find((item) => responseParts(item).length > 0) || payloads.at(-1);
    return { kind: "sse", payload };
  }

  try {
    return { kind: "json", payload: JSON.parse(trimmed) };
  } catch {
    return { kind: "non-json", payload: null };
  }
}
