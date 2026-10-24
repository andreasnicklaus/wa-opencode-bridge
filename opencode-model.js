/**
 * Parse an OpenCode model reference from a `provider/model` string (with an
 * optional `#variant` suffix) into the `Model.Ref` shape expected by the
 * OpenCode v2 API (`{ providerID, id, variant? }`).
 *
 * Returns `null` for empty/whitespace input so callers can treat "unset" uniformly.
 * Throws an Error with a helpful message for malformed input.
 */
export function parseOpenCodeModel(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const hashIndex = raw.indexOf("#");
  const modelPart = hashIndex >= 0 ? raw.slice(0, hashIndex).trim() : raw;
  const variant =
    hashIndex >= 0 ? raw.slice(hashIndex + 1).trim() : "";

  const slashIndex = modelPart.indexOf("/");
  if (slashIndex <= 0 || slashIndex === modelPart.length - 1) {
    throw new Error(
      `Invalid OPENCODE_MODEL "${raw}": expected "provider/model" (e.g. "opencode/beam-free").`,
    );
  }

  const providerID = modelPart.slice(0, slashIndex).trim();
  const id = modelPart.slice(slashIndex + 1).trim();

  if (!providerID || !id) {
    throw new Error(
      `Invalid OPENCODE_MODEL "${raw}": provider and model must not be empty.`,
    );
  }

  const model = { providerID, id };
  if (variant) model.variant = variant;
  return model;
}
