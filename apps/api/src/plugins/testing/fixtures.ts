// Test fixtures for the plugin host: an env and context for the in-process
// runtime app, and the reference plugin installed, configured and active.
import type { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import type { Database } from "@scalius/database/client";
import {
  activatePlugin,
  installPlugin,
  writePluginSettings,
  type PluginInstallation,
} from "@scalius/core/modules/plugins";
import { BUNDLED_PLUGINS } from "../bundled.gen";
import { manifest as helloManifest } from "./apps/hello/src/index";

export const PLUGIN_TEST_CREDENTIAL_KEY = "plugin-bundled-test-credential-key-0123456789";

export function pluginTestEnv(binding: D1Database, overrides: Record<string, unknown> = {}): Env {
  return {
    DB: binding,
    RL_STANDARD: { limit: vi.fn(async () => ({ success: true })) },
    JOBS_QUEUE: { send: vi.fn(async () => undefined), sendBatch: vi.fn(async () => undefined) },
    PUBLIC_API_BASE_URL: "https://api.shop.test",
    STOREFRONT_URL: "https://shop.test",
    BETTER_AUTH_URL: "https://admin.shop.test",
    JWT_SECRET: "plugin-bundled-test-jwt-secret-0123456789abcdef",
    BETTER_AUTH_SECRET: "plugin-bundled-test-auth-secret-0123456789abcdef",
    CREDENTIAL_ENCRYPTION_KEY: PLUGIN_TEST_CREDENTIAL_KEY,
    ...overrides,
  } as unknown as Env;
}

export function pluginTestCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {}, exports: {} } as unknown as ExecutionContext;
}

export async function installHello(db: Database, sqlite: DatabaseSync): Promise<PluginInstallation> {
  sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
  const bundled = BUNDLED_PLUGINS["acme.hello"]!;
  const installed = await installPlugin(db, { manifest: helloManifest, source: "bundled", bundleSha256: bundled.sha256, actorUserId: "owner" });
  const configured = await writePluginSettings(db, "acme.hello", {
    greeting: "Salam",
    discount_percent: 15,
    min_subtotal_minor: 100000,
    api_key: "hello-secret-api-key",
  }, { expectedRevision: installed.revision, credentialEncryptionKey: PLUGIN_TEST_CREDENTIAL_KEY });
  return activatePlugin(db, "acme.hello", { actorUserId: "owner", expectedRevision: configured.revision });
}

export function testCart(subtotalMinor: number) {
  return {
    currency: "BDT",
    decimalPlaces: 2,
    channel: "online_store" as const,
    lines: [{
      lineId: "l1", productId: "p1", variantId: "v1", sku: null, title: "Panjabi", quantity: 1,
      unitPriceMinor: subtotalMinor, lineTotalMinor: subtotalMinor, categoryIds: [], collectionIds: [], brandId: null, properties: {},
    }],
    subtotalMinor,
    customer: null,
    destination: null,
    discountCodes: [],
  };
}

