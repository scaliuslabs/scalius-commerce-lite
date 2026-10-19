// scalius_describe over the whole generated manifest: the compact answer is
// never larger than the full one, and every executable operation's "when"
// is its registry routing line.
import { describe, expect, it } from "vitest";
import { AGENT_OPERATIONS } from "../../generated/agent-operations.gen";
import { describeForAgent } from "./describe";

const encoder = new TextEncoder();
const size = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;

describe("describe sizes over every executable operation", () => {
  const executable = AGENT_OPERATIONS.filter((operation) => operation.exposure === "execute" || operation.exposure === "continuation");

  it("keeps compact no larger than full", () => {
    const larger = executable.filter((operation) => {
      const full = describeForAgent(operation, "full");
      const compact = describeForAgent(operation, "compact");
      return full.kind === "described" && size(compact.value) > size(full.value);
    }).map((operation) => operation.operationId);
    expect(larger).toEqual([]);
  });

  it("answers when with the registry's routing line", () => {
    const missing = executable.filter((operation) => {
      const compact = describeForAgent(operation, "compact").value as { when?: string };
      return compact.when !== operation.when || !compact.when?.startsWith("Use when ");
    }).map((operation) => operation.operationId);
    expect(missing).toEqual([]);
  });
});
