// The place import as a plugin port: an app (the Bangladesh pack) loads a
// place dataset through `ctx.api.call("dashboard.delivery_locations.import")`,
// gated by the permission its manifest requests and the merchant grants.
import { describe, expect, it } from "vitest";

import { AGENT_OPERATIONS } from "../generated/agent-operations.gen";
import type { PluginPrincipal } from "../agent-access/types";
import { authorizePluginOperation, derivePluginRiskCeiling, isOperationAvailableToPlugins } from "./authority";

const operation = AGENT_OPERATIONS.find((entry) => entry.operationId === "dashboard.delivery_locations.import")!;
const principal = (permissions: string[]): PluginPrincipal => ({
  kind: "plugin",
  pluginId: "scalius.bangladesh",
  version: "1.0.0",
  pluginName: "Bangladesh",
  actorUserId: "user_owner",
  permissions: new Set(permissions),
  riskCeiling: "write",
});

describe("the place import plugin port", () => {
  it("is a plugin operation gated by the import permission (or the full edit permission)", () => {
    expect(operation).toMatchObject({ method: "POST", pathTemplate: "/api/v1/admin/settings/delivery-locations/import", risk: "write" });
    expect(operation.rbac).toEqual({ type: "anyOf", permissions: ["settings.delivery_locations.edit", "settings.delivery_locations.import"] });
    expect(isOperationAvailableToPlugins(operation)).toBe(true);
    expect(authorizePluginOperation(principal(["settings.delivery_locations.import"]), operation)).toBe(true);
    expect(authorizePluginOperation(principal(["settings.delivery_locations.edit"]), operation)).toBe(true);
    expect(authorizePluginOperation(principal(["settings.delivery_locations.view"]), operation)).toBe(false);
  });

  it("lets the import permission reach nothing that deletes a place", () => {
    const reachable = AGENT_OPERATIONS.filter((entry) => isOperationAvailableToPlugins(entry)
      && authorizePluginOperation({ ...principal(["settings.delivery_locations.import"]), riskCeiling: "financial" }, entry));
    expect(reachable.map((entry) => entry.operationId)).toEqual(["dashboard.delivery_locations.import"]);
    expect(derivePluginRiskCeiling(new Set(["settings.delivery_locations.import"]))).toBe("write");
  });
});
