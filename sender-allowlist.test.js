import test from "node:test";
import assert from "node:assert/strict";
import { isAllowed, isLidJid, phoneFromJid } from "./sender-allowlist.js";

test("derives phone digits from a @c.us JID", () => {
  assert.equal(phoneFromJid("491500000001@c.us"), "491500000001");
});

test("derives phone digits from a @s.whatsapp.net JID", () => {
  assert.equal(phoneFromJid("491500000001@s.whatsapp.net"), "491500000001");
});

test("returns null for a @lid JID (must be resolved)", () => {
  assert.equal(phoneFromJid("100000000000001@lid"), null);
});

test("returns null for empty input", () => {
  assert.equal(phoneFromJid(""), null);
  assert.equal(phoneFromJid(null), null);
});

test("detects @lid senders", () => {
  assert.equal(isLidJid("100000000000001@lid"), true);
  assert.equal(isLidJid("491500000001@c.us"), false);
  assert.equal(isLidJid(""), false);
});

test("allows everyone when the allowlist is empty", () => {
  assert.equal(isAllowed(null, []), true);
  assert.equal(isAllowed("491500000001", []), true);
});

test("denies when phone is missing but an allowlist is set", () => {
  assert.equal(isAllowed(null, ["491500000001"]), false);
});

test("matches a resolved phone against the allowlist", () => {
  assert.equal(isAllowed("491500000001", ["491500000001"]), true);
  assert.equal(isAllowed("491500000002", ["491500000001"]), false);
});
