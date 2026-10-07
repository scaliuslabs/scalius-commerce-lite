// src/modules/fraud-checker/fraud-checker.service.ts
// The merchant's fraud checkers (`fraud-checker` settings rows, each value
// encrypted whole) and the phone lookup through the fraud port. A row names
// an installed app's fraud provider (`providerType: "<plugin id>:<provider
// id>"`), whose credentials live in the app's settings; the lookup goes
// through the first active row, reaching the app through the request's
// AppProviders. A manual tool on the order page: it advises, it never blocks.
//
// Rows saved before the Bangladesh checkers moved into the Bangladesh pack
// still name a retired built-in type (`fraudbd`, …, empty for the custom API)
// and hold its credentials. They read as the pack's provider
// (integrations/retired-providers.ts) and fail closed until the pack is
// active; the pack's activation moves their credentials and rewrites them
// (`readRetiredFraudCheckers`, `replaceRetiredFraudChecker`).

import { normalizeMarketCountry } from "@scalius/shared/markets";
import { parsePhoneNumberFromString } from "@scalius/shared/customer-utils";
import { providerErrorOf, providerServesCountry, type FraudCheck } from "@scalius/shared/plugins/providers";
import { settings } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { eq, and, desc, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { encryptCredentials, readStoredCredentialStrict } from "@scalius/core/utils/credential-encryption";
import {
  NotFoundError,
  ValidationError,
  ServiceUnavailableError,
} from "@scalius/core/errors";
import { isAppProviderId, resolveAppProvider, type AppProviders } from "../../integrations/provider-port";
import { retiredProviderReplacement } from "../../integrations/retired-providers";
import type { FraudProvider } from "./provider";

export interface FraudCheckerProvider {
  id: string;
  name: string;
  isActive: boolean;
  /** The app provider (`<plugin id>:<provider id>`) the row looks up through. */
  providerType: string;
  /** The row still holds a retired built-in checker's credentials, waiting for its app's activation. */
  retired: boolean;
}

/** A row as stored (decrypted): an app row, or a retired built-in checker with its credentials. */
interface StoredRow {
  name: string;
  isActive: boolean;
  providerType?: string;
  apiUrl?: string;
  apiKey?: string;
  apiSecret?: string;
  userId?: string;
}

const CATEGORY = "fraud-checker";

async function parseStoredRow(value: string, encryptionKey?: string): Promise<StoredRow | null> {
  try {
    const read = await readStoredCredentialStrict(value, encryptionKey, "Fraud checker provider credentials");
    if (read.error) return null;
    const parsed = JSON.parse(read.value) as StoredRow;
    return parsed && typeof parsed === "object" && typeof parsed.name === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** A stored row as the dashboard and the lookup read it; null for a type nothing provides any more. */
function toProvider(id: string, row: StoredRow): FraudCheckerProvider | null {
  const stored = row.providerType ?? "";
  const replacement = isAppProviderId(stored) ? null : retiredProviderReplacement("fraud", stored);
  const providerType = isAppProviderId(stored) ? stored : replacement;
  if (!providerType) return null;
  return { id, name: row.name, isActive: row.isActive === true, providerType, retired: replacement !== null };
}

/**
 * Get all fraud checker providers
 */
export async function getFraudProviders(
  db: Database,
  encryptionKey?: string,
  options?: { limit: number; offset: number },
): Promise<FraudCheckerProvider[]> {
  const baseQuery = db
    .select()
    .from(settings)
    .where(eq(settings.category, CATEGORY))
    .orderBy(desc(settings.updatedAt), desc(settings.key));
  const providerSettings = options
    ? await baseQuery
      .limit(Math.max(1, Math.min(options.limit, 21)))
      .offset(Math.max(0, options.offset))
    : await baseQuery;

  const providers = await Promise.all(providerSettings.map(async (setting) => {
    const data = await parseStoredRow(setting.value, encryptionKey);
    return data ? toProvider(setting.key, data) : null;
  }));
  return providers.filter((provider): provider is FraudCheckerProvider => provider !== null);
}

/**
 * Get a specific provider by ID
 */
export async function getFraudProvider(
  db: Database,
  id: string,
  encryptionKey?: string,
): Promise<FraudCheckerProvider | null> {
  const [setting] = await db
    .select()
    .from(settings)
    .where(and(eq(settings.category, CATEGORY), eq(settings.key, id)));
  if (!setting) return null;
  const data = await parseStoredRow(setting.value, encryptionKey);
  return data ? toProvider(setting.key, data) : null;
}

/**
 * Save a fraud checker row (create or update). It names an app provider only;
 * the caller checks that an installed app declares it. A row that still holds
 * a retired checker's credentials is not overwritten: activating its app moves
 * them first.
 */
export async function saveFraudProvider(
  db: Database,
  provider: { id?: string; name: string; isActive: boolean; providerType: string },
  encryptionKey: string,
): Promise<FraudCheckerProvider> {
  if (!encryptionKey) {
    throw new ServiceUnavailableError("CREDENTIAL_ENCRYPTION_KEY is required to store provider credentials.");
  }
  if (!provider.name?.trim()) throw new ValidationError("Missing required fields: name");
  if (!isAppProviderId(provider.providerType)) {
    throw new ValidationError(`Unsupported fraud checker provider type: ${provider.providerType}`);
  }
  const providerId = provider.id || nanoid();
  const existing = await getFraudProvider(db, providerId, encryptionKey);
  if (existing?.retired) {
    throw new ValidationError("This checker's keys move to its app when the app is activated. Activate it in Apps first.");
  }
  const stored: StoredRow = { name: provider.name, isActive: provider.isActive, providerType: provider.providerType };
  const storedValue = await encryptCredentials(JSON.stringify(stored), encryptionKey);

  if (existing) {
    await db
      .update(settings)
      .set({ value: storedValue, updatedAt: sql`unixepoch()` })
      .where(and(eq(settings.category, CATEGORY), eq(settings.key, providerId)));
  } else {
    const present = await db
      .select({ key: settings.key })
      .from(settings)
      .where(and(eq(settings.category, CATEGORY), eq(settings.key, providerId)))
      .get();
    // A row this key cannot read is never replaced blindly.
    if (present) throw new ValidationError("This fraud checker could not be read. Delete it and add it again.");
    await db.insert(settings).values({
      id: nanoid(),
      key: providerId,
      category: CATEGORY,
      type: "json",
      value: storedValue,
      updatedAt: sql`unixepoch()`,
    });
  }

  return { id: providerId, ...stored, providerType: provider.providerType, retired: false };
}

/**
 * Delete a fraud checker provider
 */
export async function deleteFraudProvider(db: Database, id: string): Promise<boolean> {
  const existing = await db
    .select({ key: settings.key })
    .from(settings)
    .where(and(eq(settings.category, CATEGORY), eq(settings.key, id)))
    .get();
  if (!existing) {
    throw new NotFoundError(`Fraud checker provider "${id}" not found`);
  }

  await db
    .delete(settings)
    .where(and(eq(settings.category, CATEGORY), eq(settings.key, id)));
  return true;
}

/** The row's app provider, or why it cannot be used now (merchant-facing). */
async function fraudProviderFor(
  row: FraudCheckerProvider,
  apps: AppProviders | undefined,
): Promise<{ provider: FraudProvider; issue: null } | { provider: null; issue: string }> {
  return resolveAppProvider(apps, "fraud", row.providerType);
}

/**
 * Test a provider connection with the checker's own test. A checker without
 * one, or whose app cannot be used now, says so.
 */
export async function testFraudProvider(
  db: Database,
  id: string,
  encryptionKey?: string,
  apps?: AppProviders,
): Promise<{ success: boolean; message: string }> {
  const row = await getFraudProvider(db, id, encryptionKey);
  if (!row) {
    throw new NotFoundError(`Fraud checker provider "${id}" not found`);
  }
  const choice = await fraudProviderFor(row, apps);
  if (!choice.provider) return { success: false, message: choice.issue };
  if (!choice.provider.testConnection) return { success: false, message: `${choice.provider.label} offers no connection test.` };
  try {
    const result = await choice.provider.testConnection({}, {});
    return { success: result.ok, message: result.message };
  } catch (error: unknown) {
    return { success: false, message: providerErrorOf(error)?.message ?? "Connection failed" };
  }
}

/**
 * What a lookup gives: the provider's check; or, when the buyer is in a
 * country the provider does not know (MARKETS-DESIGN step 3a), no call at all
 * and the reason; or, when the checker's app cannot be used now (not
 * installed, not active, not set up), no call and the app's reason.
 */
export type FraudLookupResult =
  | { status: "checked"; check: FraudCheck }
  | { status: "country_unsupported"; provider: string; countryCode: string | null }
  | { status: "unavailable"; provider: string; reason: string };

/** The buyer's country: the order's shipping country, else the phone's. */
function lookupCountry(phone: string, countryCode: string | null | undefined): string | null {
  const given = normalizeMarketCountry(countryCode);
  if (given) return given;
  try {
    return parsePhoneNumberFromString(phone)?.country ?? null;
  } catch {
    return null;
  }
}

/**
 * Look a phone up with one saved checker. A provider's own merchant-facing
 * error (the port's ProviderError) is kept; anything else is masked.
 */
export async function fraudLookup(
  row: FraudCheckerProvider,
  phone: string,
  apps?: AppProviders,
  options: { countryCode?: string | null } = {},
): Promise<FraudLookupResult> {
  const choice = await fraudProviderFor(row, apps);
  if (!choice.provider) return { status: "unavailable", provider: row.name, reason: choice.issue };
  const provider = choice.provider;
  const country = lookupCountry(phone, options.countryCode);
  if (!providerServesCountry(provider.countries, country)) {
    return { status: "country_unsupported", provider: provider.label, countryCode: country };
  }
  try {
    return { status: "checked", check: await provider.check({ phone }, {}) };
  } catch (error: unknown) {
    const failure = providerErrorOf(error);
    throw new ServiceUnavailableError(failure ? failure.message : "Fraud check lookup failed");
  }
}

/**
 * Lookup fraud data using the first active provider. `countryCode` is the
 * order's shipping country (else the phone's country is used).
 */
export async function fraudLookupWithActiveProvider(
  db: Database,
  phone: string,
  encryptionKey?: string,
  apps?: AppProviders,
  options: { countryCode?: string | null } = {},
): Promise<FraudLookupResult> {
  const providers = await getFraudProviders(db, encryptionKey);
  const activeProvider = providers.find((p) => p.isActive);

  if (!activeProvider) {
    throw new NotFoundError(
      "No active fraud checker provider configured",
    );
  }

  return fraudLookup(activeProvider, phone, apps, options);
}

// ── Retired built-in checkers (provider handoff) ─────────────────────────

/** A row that still holds a retired built-in checker's credentials (decrypted). */
export interface RetiredFraudChecker {
  id: string;
  name: string;
  isActive: boolean;
  /** The retired type (`default` for the custom API). */
  type: string;
  /** The app provider that replaced it. */
  replacement: string;
  /** The old fields by their stored names: apiUrl, apiKey, apiSecret, userId. */
  values: Record<string, string>;
  /** The row as stored, so the rewrite applies only to what was read. */
  storedValue: string;
  updatedAt: number;
}

/**
 * Every row that still names a retired checker, newest first, decrypted with
 * the strict reader (a row the key cannot open is left alone). Only for the
 * handoff that moves them into their app: never logged, never returned to a
 * client.
 */
export async function readRetiredFraudCheckers(db: Database, encryptionKey: string): Promise<RetiredFraudChecker[]> {
  const rows = await db
    .select({ key: settings.key, value: settings.value, updatedAt: settings.updatedAt })
    .from(settings)
    .where(eq(settings.category, CATEGORY))
    .orderBy(desc(settings.updatedAt), desc(settings.key));
  const retired: RetiredFraudChecker[] = [];
  for (const row of rows) {
    const data = await parseStoredRow(row.value, encryptionKey);
    if (!data || isAppProviderId(data.providerType ?? "")) continue;
    const type = data.providerType || "default";
    const replacement = retiredProviderReplacement("fraud", type);
    if (!replacement) continue;
    const values: Record<string, string> = {};
    for (const field of ["apiUrl", "apiKey", "apiSecret", "userId"] as const) {
      const value = data[field];
      if (typeof value === "string" && value.trim()) values[field] = value.trim();
    }
    const updatedAt = row.updatedAt instanceof Date ? row.updatedAt.getTime() : Number(row.updatedAt ?? 0);
    retired.push({ id: row.key, name: data.name, isActive: data.isActive === true, type, replacement, values, storedValue: row.value, updatedAt });
  }
  return retired;
}

/**
 * Rewrites one retired row as a row of its app provider (name and status
 * kept, credentials dropped), only while it is still the row that was read.
 */
export async function replaceRetiredFraudChecker(db: Database, checker: RetiredFraudChecker, encryptionKey: string): Promise<boolean> {
  const stored: StoredRow = { name: checker.name, isActive: checker.isActive, providerType: checker.replacement };
  const updated = await db
    .update(settings)
    .set({ value: await encryptCredentials(JSON.stringify(stored), encryptionKey), updatedAt: sql`unixepoch()` })
    .where(and(eq(settings.category, CATEGORY), eq(settings.key, checker.id), eq(settings.value, checker.storedValue)))
    .returning({ key: settings.key });
  return updated.length > 0;
}
