import test from "node:test";
import assert from "node:assert/strict";
import {
  hasSendTool,
  isControlOnlyResponse,
  latestAssistantText,
  parsePromptBody,
  responseText,
} from "./opencode-response.js";

test("parses a normal JSON assistant response", () => {
  const parsed = parsePromptBody(
    JSON.stringify({ parts: [{ type: "text", text: "Hello" }] }),
  );

  assert.equal(parsed.kind, "json");
  assert.equal(responseText(parsed.payload), "Hello");
});

test("classifies an empty successful response", () => {
  const parsed = parsePromptBody("  \n");

  assert.deepEqual(parsed, { kind: "empty", payload: null });
  assert.equal(responseText(parsed.payload), "");
});

test("classifies a non-JSON successful response", () => {
  const parsed = parsePromptBody("<!doctype html><title>error</title>");

  assert.deepEqual(parsed, { kind: "non-json", payload: null });
  assert.equal(responseText(parsed.payload), "");
});

test("recognizes reasoning-only control responses", () => {
  const parsed = parsePromptBody(
    JSON.stringify({ parts: [{ type: "reasoning", text: "internal" }] }),
  );

  assert.equal(parsed.kind, "json");
  assert.equal(isControlOnlyResponse(parsed.payload), true);
  assert.equal(responseText(parsed.payload), "");
});

test("recognizes a send tool in a session message", () => {
  const messages = [
    {
      info: { role: "assistant" },
      parts: [{ type: "tool", tool: "whatsapp_MessageSendText" }],
    },
  ];

  assert.equal(hasSendTool(messages), true);
});

test("recovers the latest assistant text but ignores user text", () => {
  const messages = [
    {
      info: { role: "user" },
      parts: [{ type: "text", text: "incoming message" }],
    },
    {
      info: { role: "assistant" },
      parts: [{ type: "reasoning", text: "internal" }],
    },
    {
      info: { role: "assistant" },
      parts: [{ type: "text", text: "reply" }],
    },
  ];

  assert.equal(latestAssistantText(messages), "reply");
});

test("parses an SSE response with a final message", () => {
  const parsed = parsePromptBody(
    [
      "event: message",
      'data: {"type":"message","parts":[{"type":"text","text":"first"}]}',
      "",
      'data: {"type":"message","parts":[{"type":"text","text":"final"}]}',
      "data: [DONE]",
    ].join("\n"),
  );

  assert.equal(parsed.kind, "sse");
  assert.equal(responseText(parsed.payload), "final");
});
