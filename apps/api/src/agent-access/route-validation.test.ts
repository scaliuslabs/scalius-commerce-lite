// Every gated dashboard operation is validated with its own route's schemas
// before anyone is asked to approve it (black-box M7), so each one must find
// its route definition among the routers the mount table mounts.
import "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));

import "../app";
import { AGENT_OPERATION_POLICIES } from "../generated/agent-operation-policies.gen";
import { isConfirmGated } from "./mcp/confirm";
import { routeConfigForOperation } from "./route-validation";

describe("route validation before approval", () => {
  it("finds the route definition of every gated dashboard operation", () => {
    const gated = AGENT_OPERATION_POLICIES.filter((operation) =>
      operation.surface === "dashboard" && isConfirmGated(operation));
    expect(gated.length).toBeGreaterThan(50);
    const missing = gated
      .filter((operation) => routeConfigForOperation(operation.operationId, operation) === null)
      .map((operation) => operation.operationId);
    expect(missing).toEqual([]);
    for (const operation of gated) {
      const route = routeConfigForOperation(operation.operationId, operation)!;
      expect(String(route.method).toUpperCase(), operation.operationId).toBe(operation.method);
    }
  }, 120_000);
});
