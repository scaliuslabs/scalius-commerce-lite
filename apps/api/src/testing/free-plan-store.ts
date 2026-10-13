/**
 * A seeded store behind the metered bindings, driven through the real
 * `ApiWorker` (fetch, queue and scheduled entrypoints). Test-only; used by
 * the Workers Free plan budget (apps/api/src/free-plan-budget.test.ts).
 */
import { eq } from "drizzle-orm";
import type { DatabaseSync } from "node:sqlite";
import { getDb, type Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { user as userTable } from "@scalius/database/schema";
import { createAuth } from "@scalius/core/auth";
import { savePlatformSettings } from "@scalius/core/modules/platform";
import { settingsMirror } from "@scalius/core/settings-store";
import { composeApiRuntimeEnv } from "../runtime/runtime-env";

import { createFreePlanMeter, type FreePlanMeter } from "./free-plan-meter";

export const STORE = {
  dashboard: "https://admin.shop.test",
  storefront: "https://shop.test",
  api: "https://api.shop.test",
  ownerEmail: "owner@shop.test",
  ownerPassword: "Correct-Horse-Battery-9",
  masterSecret: "free-plan-budget-master-secret-with-more-than-32-chars",
} as const;

export interface TestWorker {
  env: Env;
  ctx: ExecutionContext;
  fetch(request: Request): Promise<Response>;
  queue(batch: MessageBatch<Record<string, unknown>>): Promise<void>;
  scheduled(controller: ScheduledController): Promise<void>;
}

export interface FreePlanStore {
  /** Every message the metered EMAIL binding accepted. */
  emails: unknown[];
  sqlite: DatabaseSync;
  db: Database;
  meter: FreePlanMeter;
  env: Env;
  worker: TestWorker;
  /** The runtime env as the Worker composes it (derived secrets, Platform origins). */
  composed(): Promise<Env>;
  /** Sign the owner in (unmetered) and return the session cookie header value. */
  ownerCookie(): Promise<string>;
  /** An authenticated dashboard-origin request as the owner. */
  admin(path: string, init?: RequestInit): Promise<Response>;
  close(): void;
}

export interface CreateFreePlanStoreOptions {
  /** Extra bindings merged over the defaults (EMAIL, IMAGES, ...). */
  bindings?: Record<string, unknown>;
}

/** The email binding Cloudflare Email Service offers: accepts and counts a send. */
export function emailBinding(sent: Array<unknown> = []) {
  return { send: async (message: unknown) => { sent.push(message); return { messageId: `m_${sent.length}` }; } };
}

export async function createFreePlanStore(options: CreateFreePlanStoreOptions = {}): Promise<FreePlanStore> {
  const { sqlite, binding, db: shimDb } = createSqliteD1Database({ foreignKeys: true });
  void shimDb;
  const meter = createFreePlanMeter({ d1: binding, sqlite });
  const emails: unknown[] = [];
  const env = {
    ...meter.bindings,
    EMAIL: meter.service(emailBinding(emails)),
    SCALIUS_SECRET: STORE.masterSecret,
    CREDENTIAL_ENCRYPTION_KEY: btoa("0123456789abcdef0123456789abcdef"),
    CF_VERSION_METADATA: { id: "free-plan-budget", tag: "", timestamp: "" },
    ...options.bindings,
  } as unknown as Env;
  const db = getDb({ DB: binding } as unknown as Env);
  // Saved through the metered Cache API, so Worker entry finds its mirror warm.
  const originalCaches = (globalThis as { caches?: unknown }).caches;
  (globalThis as { caches?: unknown }).caches = meter.caches;
  try {
    await savePlatformSettings(
      db,
      { storefrontUrl: STORE.storefront, apiUrl: STORE.api, dashboardUrl: STORE.dashboard },
      settingsMirror(env),
    );
  } finally {
    (globalThis as { caches?: unknown }).caches = originalCaches;
  }

  const { default: ApiWorker } = await import("../worker");
  const worker = new (ApiWorker as unknown as new () => TestWorker)();
  worker.env = env;
  worker.ctx = meter.ctx;

  const composed = () => composeApiRuntimeEnv(env);
  let cookie: string | null = null;

  async function ownerCookie(): Promise<string> {
    if (cookie) return cookie;
    const auth = createAuth(await composed());
    const created = await auth.api.signUpEmail({
      body: { email: STORE.ownerEmail, password: STORE.ownerPassword, name: "Owner" },
    });
    await db.update(userTable).set({ isSuperAdmin: true, role: "admin" }).where(eq(userTable.id, created.user.id));
    const response = await worker.fetch(new Request(`${STORE.dashboard}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: STORE.dashboard },
      body: JSON.stringify({ email: STORE.ownerEmail, password: STORE.ownerPassword }),
    }));
    const header = response.headers.getSetCookie().find((value) => value.includes("session_token="));
    if (!header) throw new Error(`Sign-in did not set a session cookie (${response.status})`);
    cookie = header.split(";")[0]!;
    return cookie;
  }

  return {
    emails,
    sqlite,
    db,
    meter,
    env,
    worker,
    composed,
    ownerCookie,
    async admin(path, init = {}) {
      const headers = new Headers(init.headers);
      headers.set("Cookie", await ownerCookie());
      headers.set("Origin", STORE.dashboard);
      if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
      return worker.fetch(new Request(`${STORE.dashboard}${path}`, { ...init, headers }));
    },
    close: () => sqlite.close(),
  };
}
