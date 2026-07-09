import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { describe, expect, it } from "vitest";
import app from "../../app";
import { finalizeOpenApiContract } from "../../openapi-contract";
import {
  ADMIN_OPENAPI_OPERATION_COUNT,
  ADMIN_OPENAPI_PATH_COUNT,
  ADMIN_OPENAPI_PATH_INVENTORY,
  type AdminHttpMethod,
} from "./admin-operation-inventory";
import {
  ADMIN_COMMAND_POLICY_DIGEST,
  ADMIN_COMMAND_REGISTRY,
  auditAdminCommandRegistry,
  resolveAdminApiCapability,
} from "./admin-command-registry";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function liveAdminOperations(): string[] {
  const document = finalizeOpenApiContract(app.getOpenAPIDocument({
    openapi: "3.0.0",
    info: { title: "Admin registry drift test", version: "1" },
  }));

  return Object.entries(document.paths ?? {}).flatMap(([path, pathItem]) => {
    if (!path.startsWith("/api/v1/admin/")) return [];
    return METHODS
      .filter((method) => pathItem && method.toLowerCase() in pathItem)
      .map((method) => `${method} ${path}`);
  }).sort();
}

function frozenAdminOperations(): string[] {
  return ADMIN_OPENAPI_PATH_INVENTORY.flatMap(([path, methods]) =>
    methods.map((method) => `${method} ${path}`),
  ).sort();
}

function concretePath(pathTemplate: string): string {
  return pathTemplate
    .replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, "registry-id")
    .replace(/:[A-Za-z][A-Za-z0-9_]*/g, "registry-id");
}

describe("Admin command registry drift", () => {
  it("matches every current authenticated Admin OpenAPI operation exactly", () => {
    expect(ADMIN_OPENAPI_PATH_COUNT).toBe(218);
    expect(ADMIN_OPENAPI_OPERATION_COUNT).toBe(317);
    expect(ADMIN_OPENAPI_PATH_INVENTORY).toHaveLength(218);
    expect(frozenAdminOperations()).toEqual(liveAdminOperations());
    expect(ADMIN_COMMAND_REGISTRY).toHaveLength(317);
  });

  it("resolves the exact effective ROUTE_PERMISSIONS requirement for every operation", () => {
    for (const descriptor of ADMIN_COMMAND_REGISTRY) {
      const permission = getRoutePermission(
        concretePath(descriptor.pathTemplate),
        descriptor.method as AdminHttpMethod,
      );
      expect(permission, descriptor.operationKey).not.toBeNull();
      expect(resolveAdminApiCapability(descriptor.method, descriptor.pathTemplate), descriptor.operationKey)
        .toBe(descriptor);
    }
    expect(auditAdminCommandRegistry()).toEqual([]);
  });

  it("makes permission and policy changes deliberate through a stable digest", () => {
    expect(ADMIN_COMMAND_POLICY_DIGEST).toBe("admin-command-v1-317-7c2f4ee1");
  });

  it("contains no generic HTTP, OpenAPI, URL, SQL, shell, or DOM executor", () => {
    const registrySource = readFileSync(
      fileURLToPath(new URL("./admin-command-registry.ts", import.meta.url)),
      "utf8",
    );
    const uiSource = readFileSync(
      fileURLToPath(new URL("./admin-ui-affordance-registry.ts", import.meta.url)),
      "utf8",
    );
    const source = `${registrySource}\n${uiSource}`;

    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bexecute(?:Url|OpenApi|Sql|Shell|Dom)\b/i);
    expect(source).not.toMatch(/new\s+URL\s*\(/);
    expect(source).not.toContain("querySelector(");
  });
});
