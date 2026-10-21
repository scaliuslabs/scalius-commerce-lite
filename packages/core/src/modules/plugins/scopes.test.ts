// App access scopes against the live RBAC catalog: every permission a scope
// confers exists and is plugin-grantable, a scope's staff gate is one of its
// own permissions, and rows stored before scopes read safely.
import { describe, expect, it } from "vitest";
import {
  PLUGIN_API_VERSION,
  PLUGIN_SCOPES,
  PLUGIN_SCOPE_NAMES,
  PROTECTED_CUSTOMER_DATA,
  PROTECTED_DATA_SCOPES,
  isCapabilityScope,
  isProtectedDataScope,
  isSensitivePluginScope,
  legacyPermissionScope,
  parsePluginManifest,
  type PluginScopeDefinition,
} from "@scalius/shared/plugins";
import { PERMISSION_METADATA } from "../../auth/rbac/permission-metadata";
import { effectivePluginPermissions, isFirstPartyBundledPlugin, isKnownPermission, isPluginGrantablePermission } from "./grants";
import { parseStoredPluginGrant, upgradeStoredPluginManifest } from "./installations";

describe("PLUGIN_SCOPES", () => {
  it("maps every access scope to live, plugin-grantable RBAC permissions", () => {
    for (const scope of PLUGIN_SCOPE_NAMES.filter((name) => !isProtectedDataScope(name) && !isCapabilityScope(name))) {
      const { rbac, staff } = PLUGIN_SCOPES[scope];
      expect(rbac.length, scope).toBeGreaterThan(0);
      for (const permission of rbac) {
        expect(isKnownPermission(permission), `${scope}: ${permission}`).toBe(true);
        expect(isPluginGrantablePermission(permission), `${scope}: ${permission}`).toBe(true);
      }
      expect((rbac as readonly string[]).includes(staff), `${scope} staff gate`).toBe(true);
      expect(scope).toMatch(/^(read|write)_[a-z]+(_[a-z]+)*$/);
    }
  });

  it("keeps capability scopes sensitive and RBAC-free: the bridge checks them by name", () => {
    const capabilities = PLUGIN_SCOPE_NAMES.filter((name) => isCapabilityScope(name));
    expect(capabilities).toEqual(["send_messages_any"]);
    for (const scope of capabilities) {
      const definition = PLUGIN_SCOPES[scope] as PluginScopeDefinition;
      expect(definition.rbac, scope).toEqual([]);
      expect(definition.protects, scope).toBeUndefined();
      expect(isKnownPermission(definition.staff), scope).toBe(true);
      expect(isSensitivePluginScope(scope), scope).toBe(true);
      expect(effectivePluginPermissions({ scopes: [scope] }).size, scope).toBe(0);
    }
  });

  it("has one protected customer data scope per category, conferring no RBAC", () => {
    const protectedScopes = PLUGIN_SCOPE_NAMES.filter((name) => isProtectedDataScope(name));
    expect(protectedScopes.sort()).toEqual(Object.values(PROTECTED_DATA_SCOPES).sort());
    for (const category of PROTECTED_CUSTOMER_DATA) {
      const definition = PLUGIN_SCOPES[PROTECTED_DATA_SCOPES[category]] as PluginScopeDefinition;
      expect(definition.protects).toBe(category);
      expect(definition.rbac).toEqual([]);
      expect(isKnownPermission(definition.staff)).toBe(true);
    }
  });

  it("keeps stock out of write_products and contacts out of write_marketing", () => {
    expect(effectivePluginPermissions({ scopes: ["write_products"] }).has("products.adjust_stock")).toBe(false);
    expect(effectivePluginPermissions({ scopes: ["write_inventory"] }).has("products.adjust_stock")).toBe(true);
    expect([...effectivePluginPermissions({ scopes: ["read_inventory"] })]).toEqual(["inventory.view"]);
    expect([...effectivePluginPermissions({ scopes: ["write_marketing"] })]).toEqual(["marketing.send"]);
  });

  // Security audit S3: marking an invoice paid needs its own Sensitive scope.
  it("keeps recording invoice payments out of write_orders, under the Sensitive write_payments", () => {
    expect(effectivePluginPermissions({ scopes: ["write_orders"] }).has("orders.record_payment")).toBe(false);
    expect([...effectivePluginPermissions({ scopes: ["write_payments"] })].sort()).toEqual(["orders.record_payment", "orders.view"]);
    expect(isSensitivePluginScope("write_payments")).toBe(true);
    expect(PERMISSION_METADATA["orders.record_payment"].isSensitive).toBe(true);
  });

  // Security audit N3: an invoicing app that records transfers does not also charge cards.
  it("keeps off-session charging out of write_payments, under its own Sensitive scope", () => {
    expect(effectivePluginPermissions({ scopes: ["write_payments"] }).has("orders.charge_saved_methods")).toBe(false);
    expect([...effectivePluginPermissions({ scopes: ["write_payment_methods"] })].sort()).toEqual(["orders.charge_saved_methods", "orders.view"]);
    expect(isSensitivePluginScope("write_payment_methods")).toBe(true);
    expect(PERMISSION_METADATA["orders.charge_saved_methods"].isSensitive).toBe(true);
  });

  it("makes every write scope include its read scope", () => {
    for (const scope of PLUGIN_SCOPE_NAMES.filter((name) => name.startsWith("write_"))) {
      const read = `read_${scope.slice("write_".length)}` as keyof typeof PLUGIN_SCOPES;
      if (!(read in PLUGIN_SCOPES)) continue;
      const writes = new Set<string>(PLUGIN_SCOPES[scope].rbac);
      expect(PLUGIN_SCOPES[read].rbac.every((permission) => writes.has(permission)), scope).toBe(true);
    }
  });

  it("confers RBAC only through the table, and nothing for unknown names", () => {
    expect([...effectivePluginPermissions({ scopes: ["read_orders"] })]).toEqual(["orders.view"]);
    expect(effectivePluginPermissions({ scopes: ["orders.view" as never, "team_manage" as never] }).size).toBe(0);
    expect(effectivePluginPermissions(null).size).toBe(0);
  });

  it("marks the sensitive areas a merchant should notice", () => {
    const sensitive = PLUGIN_SCOPE_NAMES.filter((scope) => PLUGIN_SCOPES[scope].rbac
      .some((permission) => (PERMISSION_METADATA as Record<string, { isSensitive?: boolean }>)[permission]?.isSensitive === true));
    expect(sensitive).toEqual(expect.arrayContaining(["read_discounts", "write_discounts", "read_settings"]));
  });
});

describe("app tiers", () => {
  it("treats only bundled scalius.* apps as first-party", () => {
    expect(isFirstPartyBundledPlugin({ pluginId: "scalius.bangladesh", source: "bundled" })).toBe(true);
    expect(isFirstPartyBundledPlugin({ pluginId: "scalius.bangladesh", source: "registry" })).toBe(false);
    expect(isFirstPartyBundledPlugin({ pluginId: "acme.hello", source: "bundled" })).toBe(false);
  });
});

describe("rows stored before scopes", () => {
  const legacy = {
    id: "acme.places",
    name: "Places",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "Loads places.",
    author: { name: "Acme" },
    permissions: ["settings.delivery_locations.import", "orders.view", "orders.edit", "team.manage"],
    routes: { admin: [{ name: "panel", methods: ["GET"], permission: "orders.view" }] },
  };

  it("reads a legacy manifest as the scopes it asked for", () => {
    expect(legacyPermissionScope("orders.view")).toBe("read_orders");
    expect(legacyPermissionScope("orders.edit")).toBe("write_orders");
    expect(legacyPermissionScope("team.manage")).toBeNull();
    const upgraded = upgradeStoredPluginManifest(legacy);
    expect(upgraded.scopes).toEqual(["write_places", "read_orders", "write_orders"]);
    expect(upgraded).not.toHaveProperty("permissions");
    const parsed = parsePluginManifest(upgraded);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.manifest.routes.admin[0]).toMatchObject({ name: "panel", scope: "read_orders" });
    // A current manifest passes through untouched.
    expect(upgradeStoredPluginManifest({ scopes: ["read_orders"] })).toEqual({ scopes: ["read_orders"] });
  });

  it("reads a manifest stored before storefront extensions and admin nesting in the current shape", () => {
    const stored = {
      id: "acme.notes", name: "Notes", version: "1.0.0", apiVersion: PLUGIN_API_VERSION, description: "Notes.", author: { name: "Acme" },
      scopes: ["write_orders"],
      objects: { notes: { name: "Notes", fields: [{ key: "text", name: "Text", type: "multi_line_text" }] } },
      functions: [
        { point: "buyer.ui", targets: ["checkout.contact.after", "account.overview"], reads: [{ as: "note", object: "notes", key: "customer" }] },
        { point: "cart.validate" },
      ],
      settings: [{ key: "note", label: "Note", type: "text", group: "texts" }],
      settingsGroups: [{ id: "texts", title: "Texts" }],
      timeline: [{ kind: "noted", title: "Note added" }],
      admin: { pages: [] },
    };
    const parsed = parsePluginManifest(upgradeStoredPluginManifest(stored));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    expect(parsed.manifest.functions.map((fn) => fn.point)).toEqual(["cart.validate"]);
    expect(parsed.manifest.storefront.extensions).toEqual([
      { target: "checkout.contact.after", reads: [{ as: "note", object: "notes", key: "customer" }] },
      { target: "account.overview", reads: [{ as: "note", object: "notes", key: "customer" }] },
    ]);
    expect(parsed.manifest.admin.settingsGroups.map((group) => group.id)).toEqual(["texts"]);
    expect(parsed.manifest.admin.timeline).toEqual([{ kind: "noted", title: "Note added" }]);
    // Idempotent: the current shape reads as itself.
    const current = upgradeStoredPluginManifest(stored);
    expect(upgradeStoredPluginManifest(current)).toEqual(current);
  });

  it("never translates a legacy grant into wider scopes: it waits for approval, unless it granted nothing", () => {
    const flags = { allowedHosts: [], events: [], functions: [], blockingFunctions: [], providers: [], publicRoutes: false, storefrontScripts: [], storefrontSurfaces: false, customFieldOwners: [] };
    expect(parseStoredPluginGrant(JSON.stringify({ ...flags, permissions: ["orders.view"] }))).toBeNull();
    expect(parseStoredPluginGrant(JSON.stringify({ ...flags, permissions: [] }))).toMatchObject({ scopes: [] });
    expect(parseStoredPluginGrant(JSON.stringify({ ...flags, scopes: ["read_orders"] }))).toMatchObject({ scopes: ["read_orders"] });
    expect(parseStoredPluginGrant(JSON.stringify({ ...flags, scopes: ["orders.view"] }))).toBeNull();
  });

  it("reads a provider kind approved under its earlier name as the current kind, so the app stays approved", () => {
    const flags = { scopes: [], allowedHosts: [], events: [], functions: [], blockingFunctions: [], publicRoutes: false, storefrontScripts: [], storefrontSurfaces: false, customFieldOwners: [] };
    expect(parseStoredPluginGrant(JSON.stringify({ ...flags, providers: ["sms", "fraud", "courier_history"] }))?.providers).toEqual(["sms", "courier_history"]);
  });
});
