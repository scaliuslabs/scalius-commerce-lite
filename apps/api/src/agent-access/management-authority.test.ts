import { describe, expect, it } from "vitest";
import {
  assertAgentConnectionScope,
  assertSubordinateGrantSelection,
  getAgentConnectionListScope,
} from "./management-authority";
import type { AgentPrincipal } from "./types";

const principal: AgentPrincipal = {
  kind: "agent",
  grantId: "agr_0123456789abcdefghij",
  credentialId: "agc_0123456789abcdefghij",
  ownerUserId: "11111111-1111-4111-8111-111111111111",
  isSuperAdmin: true,
  resource: "dashboard",
  grantKind: "pat",
  preset: "custom",
  permissions: new Set(["agent_access.view", "agent_access.manage"]),
  riskCeiling: "security",
  authorityRevision: 1,
  expiresAt: new Date("2030-01-01T00:00:00.000Z"),
};

describe("agent connection management authority", () => {
  it("forces both owner and resource into list/count pagination scope", () => {
    expect(getAgentConnectionListScope(principal)).toEqual({
      ownerUserId: principal.ownerUserId,
      resource: "dashboard",
    });
    expect(getAgentConnectionListScope(undefined)).toEqual({});
  });

  it("conceals foreign owners and cross-resource grants", () => {
    expect(() => assertAgentConnectionScope({
      id: principal.grantId,
      ownerUserId: "22222222-2222-4222-8222-222222222222",
      resource: "dashboard",
    }, principal)).toThrow("Agent connection not found");
    expect(() => assertAgentConnectionScope({
      id: principal.grantId,
      ownerUserId: principal.ownerUserId,
      resource: "storefront",
    }, principal)).toThrow("Agent connection not found");
  });

  it("makes self-only mutations immune to grant and credential pivoting", () => {
    expect(() => assertAgentConnectionScope({
      id: "agr_abcdefghij0123456789",
      ownerUserId: principal.ownerUserId,
      resource: principal.resource,
    }, principal, true)).toThrow("Agent connection not found");
    expect(() => assertAgentConnectionScope({
      id: principal.grantId,
      ownerUserId: principal.ownerUserId,
      resource: principal.resource,
    }, principal, true)).not.toThrow();
  });

  it("rejects permission, resource, risk, and lifetime escalation", () => {
    const base = {
      resource: "dashboard" as const,
      permissions: ["agent_access.view"],
      riskCeiling: "read" as const,
      expiresAt: new Date("2029-01-01T00:00:00.000Z"),
    };
    expect(() => assertSubordinateGrantSelection(base, principal)).not.toThrow();
    expect(() => assertSubordinateGrantSelection({ ...base, permissions: ["products.delete"] }, principal)).toThrow();
    expect(() => assertSubordinateGrantSelection({ ...base, resource: "storefront" }, principal)).toThrow();
    expect(() => assertSubordinateGrantSelection({ ...base, expiresAt: new Date("2031-01-01T00:00:00.000Z") }, principal)).toThrow();
    expect(() => assertSubordinateGrantSelection(
      { ...base, riskCeiling: "security" },
      { ...principal, riskCeiling: "write" },
    )).toThrow();
  });
});
