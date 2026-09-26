import { describe, expect, it, vi } from "vitest";
import { getOptionalExecutionContext } from "./execution-context";

describe("optional Worker execution context", () => {
  it("returns an available context and tolerates Hono's missing-context getter", () => {
    const executionCtx = { waitUntil: vi.fn() };
    expect(getOptionalExecutionContext({ executionCtx })).toBe(executionCtx);
    expect(getOptionalExecutionContext({})).toBeUndefined();
    expect(getOptionalExecutionContext({ get executionCtx(): never { throw new Error("No execution context"); } })).toBeUndefined();
  });
});
