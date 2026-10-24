import test from "node:test";
import assert from "node:assert/strict";
import { parseOpenCodeModel } from "./opencode-model.js";

test("returns null for unset/empty input", () => {
  assert.equal(parseOpenCodeModel(undefined), null);
  assert.equal(parseOpenCodeModel(null), null);
  assert.equal(parseOpenCodeModel(""), null);
  assert.equal(parseOpenCodeModel("   "), null);
});

test("parses provider/model", () => {
  assert.deepEqual(parseOpenCodeModel("opencode/beam-free"), {
    providerID: "opencode",
    id: "beam-free",
  });
});

test("parses an optional #variant suffix", () => {
  assert.deepEqual(parseOpenCodeModel("anthropic/claude-sonnet-4-5#fast"), {
    providerID: "anthropic",
    id: "claude-sonnet-4-5",
    variant: "fast",
  });
});

test("keeps slashes inside the model id", () => {
  assert.deepEqual(parseOpenCodeModel("openai/gpt-4o/mini"), {
    providerID: "openai",
    id: "gpt-4o/mini",
  });
});

test("trims surrounding whitespace", () => {
  assert.deepEqual(parseOpenCodeModel("  opencode/beam-free  "), {
    providerID: "opencode",
    id: "beam-free",
  });
});

test("throws on malformed input", () => {
  for (const value of ["beam-free", "/beam-free", "opencode/"]) {
    // empty string is handled as null, not an error
    if (value === "") continue;
    assert.throws(() => parseOpenCodeModel(value), /Invalid OPENCODE_MODEL/);
  }
});
