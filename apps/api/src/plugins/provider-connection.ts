// The last connection test of each app provider (QA round 1, m17): a
// provider that offers `testConnection` is "Ready" only after a test passed
// with the settings it has now; until then it is "Set up (not tested)".
//
// Tests run only when the merchant asks (Test connection): page loads read
// the stored outcome and never call a provider. One `system_kv` row per
// provider (`provider-test:<plugin id>:<provider id>`) holds the outcome, when
// it ran, the provider's merchant-safe message on failure, and a fingerprint
// of the stored settings it ran with. Saving any of the provider's settings
// changes the fingerprint (a secret's ciphertext changes on every save), so
// a test of old keys never vouches for new ones. The fingerprint hashes the
// stored form only: secrets stay ciphertext, never decrypted here.

import type { Database } from "@scalius/database/client";
import type { PluginInstallation } from "@scalius/core/modules/plugins";
import { getSystemKvMany, putSystemKv } from "@scalius/core/utils/system-kv";
import { declaredProviderOperations } from "@scalius/shared/plugins/providers";
import { qualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";

type Declaration = PluginInstallation["manifest"]["providers"][number];

const KEY_PREFIX = "provider-test:";
const MESSAGE_MAX = 300;

/** How a provider's connection stands: no test offered, not tested with these settings, or the last result. */
export type ProviderConnectionStatus = "none" | "untested" | "passed" | "failed";

export interface ProviderConnection {
  status: ProviderConnectionStatus;
  /** When the test that set `passed` or `failed` ran (ISO). */
  testedAt: string | null;
  /** The provider's answer to a failed test (merchant-safe: the host masks it). */
  message: string | null;
}

interface StoredTest {
  ok: boolean;
  at: number;
  fingerprint: string;
  message?: string;
}

export function providerOffersConnectionTest(declaration: Declaration): boolean {
  return declaredProviderOperations(declaration).includes("testConnection");
}

/** A hash of the stored settings the provider runs with (its own keys, else every app setting). */
async function settingsFingerprint(installation: PluginInstallation, declaration: Declaration): Promise<string> {
  const keys = declaration.settings ? [...declaration.settings] : installation.manifest.settings.map((field) => field.key);
  const stored = keys.sort().map((key) => [key, installation.storedSettings[key] ?? null]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([installation.pluginId, declaration.id, stored])));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseStored(value: string | null | undefined): StoredTest | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredTest>;
    return typeof parsed.ok === "boolean" && typeof parsed.at === "number" && typeof parsed.fingerprint === "string"
      ? { ok: parsed.ok, at: parsed.at, fingerprint: parsed.fingerprint, ...(typeof parsed.message === "string" ? { message: parsed.message } : {}) }
      : null;
  } catch {
    return null;
  }
}

/** Records the outcome of a test that called the provider. */
export async function recordProviderConnectionTest(
  db: Database,
  installation: PluginInstallation,
  declaration: Declaration,
  result: { ok: boolean; message: string },
): Promise<void> {
  const stored: StoredTest = {
    ok: result.ok,
    at: Math.floor(Date.now() / 1000),
    fingerprint: await settingsFingerprint(installation, declaration),
    ...(result.ok ? {} : { message: result.message.slice(0, MESSAGE_MAX) }),
  };
  await putSystemKv(db, `${KEY_PREFIX}${qualifiedProviderId(installation.pluginId, declaration.id)}`, JSON.stringify(stored));
}

/** The connection of every given provider of one app, in one read. */
export async function providerConnections(
  db: Database,
  installation: PluginInstallation,
  declarations: readonly Declaration[],
): Promise<Map<string, ProviderConnection>> {
  const tested = declarations.filter(providerOffersConnectionTest);
  const ids = tested.map((declaration) => qualifiedProviderId(installation.pluginId, declaration.id));
  const rows = ids.length > 0 ? await getSystemKvMany(db, ids.map((id) => `${KEY_PREFIX}${id}`)) : new Map<string, string>();
  const result = new Map<string, ProviderConnection>();
  for (const declaration of declarations) {
    const id = qualifiedProviderId(installation.pluginId, declaration.id);
    if (!providerOffersConnectionTest(declaration)) {
      result.set(id, { status: "none", testedAt: null, message: null });
      continue;
    }
    const stored = parseStored(rows.get(`${KEY_PREFIX}${id}`));
    if (!stored || stored.fingerprint !== await settingsFingerprint(installation, declaration)) {
      result.set(id, { status: "untested", testedAt: null, message: null });
      continue;
    }
    result.set(id, {
      status: stored.ok ? "passed" : "failed",
      testedAt: new Date(stored.at * 1000).toISOString(),
      message: stored.ok ? null : stored.message ?? null,
    });
  }
  return result;
}
