// The place import as a plugin port: an app (the Bangladesh pack, or any
// place pack) loads a place dataset through
// `ctx.api.call("delivery_locations.import")`, a stable app-API
// operation, gated by the `write_places` scope its manifest requests and the
// merchant grants.
import { describe, expect, it } from "vitest";

import { effectivePluginPermissions } from "@scalius/core/modules/plugins";
import { AGENT_OPERATIONS } from "../generated/agent-operations.gen";
import type { PluginPrincipal } from "../agent-access/types";
import { authorizePluginOperation, derivePluginRiskCeiling, isOperationAvailableToPlugin } from "./authority";

const operation = AGENT_OPERATIONS.find((entry) => entry.operationId === "dashboard.delivery_locations.import")!;
const principal = (permissions: Iterable<string>, firstParty = false): PluginPrincipal => ({
  kind: "plugin",
  pluginId: firstParty ? "scalius.bangladesh" : "acme.places",
  version: "1.0.0",
  pluginName: "Places",
  actorUserId: "user_owner",
  firstParty,
  permissions: new Set(permissions),
  protectedData: new Set(),
  riskCeiling: "write",
});
const writePlaces = effectivePluginPermissions({ scopes: ["write_places"] });

describe("the place import plugin port", () => {
  it("is a stable operation gated by the write_places scope (or the full edit permission)", () => {
    expect(operation).toMatchObject({ method: "POST", pathTemplate: "/api/v1/admin/settings/delivery-locations/import", risk: "write", stability: "stable" });
    expect(operation.rbac).toEqual({ type: "anyOf", permissions: ["settings.delivery_locations.edit", "settings.delivery_locations.import"] });
    expect(isOperationAvailableToPlugin(operation, false)).toBe(true);
    expect(authorizePluginOperation(principal(writePlaces), operation)).toBe(true);
    expect(authorizePluginOperation(principal(["settings.delivery_locations.view"]), operation)).toBe(false);
  });

  it("lets write_places reach nothing that deletes a place, in either tier", () => {
    for (const firstParty of [false, true]) {
      const reachable = AGENT_OPERATIONS.filter((entry) => authorizePluginOperation({ ...principal(writePlaces, firstParty), riskCeiling: "financial" }, entry));
      expect(reachable.map((entry) => entry.operationId)).toContain("dashboard.delivery_locations.import");
      expect(reachable.filter((entry) => entry.risk !== "read" && entry.operationId !== "dashboard.delivery_locations.import")).toEqual([]);
      expect(derivePluginRiskCeiling(writePlaces, firstParty)).toBe("write");
    }
  });
});
