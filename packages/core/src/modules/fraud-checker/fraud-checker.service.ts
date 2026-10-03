// src/modules/fraud-checker/fraud-checker.service.ts
// The merchant's fraud checkers (`fraud-checker` settings rows, each value
// encrypted whole) and the phone lookup through the fraud port. A row is a
// built-in checker with its credentials, or an app provider
// (`providerType: "<plugin id>:<provider id>"`) whose credentials live in the
// app's settings; the lookup goes through the first active row, reaching an
// app through the request's AppProviders. A manual tool on the order page:
// it advises, it never blocks.

import { normalizeMarketCountry } from "@scalius/shared/markets";
import { parsePhoneNumberFromString } from "@scalius/shared/customer-utils";
import { providerServesCountry } from "@scalius/shared/plugins/providers";
import { settings } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { eq, and, desc, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { providerErrorOf, type FraudCheck } from "@scalius/shared/plugins/providers";
import { encryptCredentials, readStoredCredentialStrict } from "@scalius/core/utils/credential-encryption";
import {
  NotFoundError,
  ValidationError,
  ServiceUnavailableError,
} from "@scalius/core/errors";
import { bindProvider, isAppProviderId, resolveAppProvider, type AppProviders } from "../../integrations/provider-port";
import { builtInFraudChecker, type FraudProvider } from "./provider";
import {
  getFraudCheckProviderDefinition,
  isFraudCheckProviderType,
} from "./provider-definitions";

export interface FraudCheckerProvider {
  id: string;
  name: string;
  /** Built-in checkers only; empty for an app provider. */
  apiUrl: string;
  /** Built-in checkers only; empty for an app provider. */
  apiKey: string;
  apiSecret?: string;
  userId?: string;
  isActive: boolean;
  /** A built-in type (absent: "default") or an app provider's `<plugin id>:<provider id>`. */
  providerType?: string;
}

const CATEGORY = "fraud-checker";
/** The number a connection test looks up when the provider has no testConnection. */
const TEST_PHONE = "+8801700000000";

export function getFraudProviderUrlIssue(value: string): string | null {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || (parsed.port && parsed.port !== "443")
      || parsed.search
      || parsed.hash
    ) {
      return "Provider URL must be an absolute public HTTPS URL without credentials, a custom port, query parameters, or a fragment.";
    }
    if (
      !hostname.includes(".")
      || hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname.endsWith(".local")
      || hostname.endsWith(".internal")
      || /^\[.*\]$/.test(hostname)
      || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
    ) {
      return "Provider URL must use a public HTTPS hostname.";
    }
    return null;
  } catch {
    return "Provider URL must be a valid absolute public HTTPS URL.";
  }
}

function assertFraudProviderUrl(value: string): void {
  const issue = getFraudProviderUrlIssue(value);
  if (issue) throw new ValidationError(issue);
}

async function parseStoredProvider(
  value: string,
  encryptionKey?: string,
): Promise<Omit<FraudCheckerProvider, "id"> | null> {
  try {
    const read = await readStoredCredentialStrict(
      value,
      encryptionKey,
      "Fraud checker provider credentials",
    );
    if (read.error) return null;
    return JSON.parse(read.value);
  } catch {
    return null;
  }
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
    const data = await parseStoredProvider(setting.value, encryptionKey);
    if (!data) return null;
    return {
      id: setting.key,
      ...data,
    };
  }));

  return providers.filter(Boolean) as FraudCheckerProvider[];
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

  const data = await parseStoredProvider(setting.value, encryptionKey);
  if (!data) return null;
  return {
    id: setting.key,
    ...data,
  };
}

/** What a row stores: a built-in checker's credentials, or only the app provider it names. */
function storedProviderData(provider: Omit<FraudCheckerProvider, "id">): Omit<FraudCheckerProvider, "id"> {
  const providerType = provider.providerType ?? "default";
  if (isAppProviderId(providerType)) {
    if (!provider.name?.trim()) throw new ValidationError("Missing required fields: name");
    // The app's own settings hold its credentials (encrypted, masked).
    return { name: provider.name, apiUrl: "", apiKey: "", isActive: provider.isActive, providerType };
  }

  assertFraudProviderUrl(provider.apiUrl);
  if (!isFraudCheckProviderType(providerType)) {
    throw new ValidationError(`Unsupported fraud checker provider type: ${providerType}`);
  }
  const definition = getFraudCheckProviderDefinition(providerType);
  const requiredFields = [
    ["name", provider.name],
    ["apiUrl", provider.apiUrl],
    ...definition.requiredFields.map((field) => [field, provider[field]] as const),
  ];
  const missingFields = requiredFields
    .filter(([, value]) => !value || String(value).trim() === "")
    .map(([field]) => field);

  if (missingFields.length > 0) {
    throw new ValidationError(
      `Missing required fields for ${definition.label}: ${missingFields.join(", ")}`,
    );
  }

  return {
    name: provider.name,
    apiUrl: provider.apiUrl,
    apiKey: provider.apiKey,
    ...(provider.apiSecret ? { apiSecret: provider.apiSecret } : {}),
    ...(provider.userId ? { userId: provider.userId } : {}),
    isActive: provider.isActive,
    providerType,
  };
}

/**
 * Save a fraud checker provider (create or update). An app provider row
 * names the app only; the caller checks that an installed app declares it.
 */
export async function saveFraudProvider(
  db: Database,
  provider: Omit<FraudCheckerProvider, "id"> & { id?: string },
  encryptionKey: string,
): Promise<FraudCheckerProvider> {
  if (!encryptionKey) {
    throw new ServiceUnavailableError("CREDENTIAL_ENCRYPTION_KEY is required to store provider credentials.");
  }

  const providerData = storedProviderData(provider);
  const providerId = provider.id || nanoid();
  const storedValue = await encryptCredentials(JSON.stringify(providerData), encryptionKey);

  // Check if provider exists
  const existing = await db
    .select({ key: settings.key })
    .from(settings)
    .where(and(eq(settings.category, CATEGORY), eq(settings.key, providerId)))
    .get();

  if (existing) {
    // Update
    await db
      .update(settings)
      .set({
        value: storedValue,
        updatedAt: sql`unixepoch()`,
      })
      .where(
        and(eq(settings.category, CATEGORY), eq(settings.key, providerId)),
      );
  } else {
    // Create
    await db.insert(settings).values({
      id: nanoid(),
      key: providerId,
      category: CATEGORY,
      type: "json",
      value: storedValue,
      updatedAt: sql`unixepoch()`,
    });
  }

  return {
    id: providerId,
    ...providerData,
  };
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

/**
 * A saved checker as the fraud port: a built-in one with the row's
 * credentials, or the app provider it names (through `apps`, failing closed
 * when the app cannot run or is not set up).
 */
async function fraudProviderFor(row: FraudCheckerProvider, apps: AppProviders | undefined): Promise<FraudProvider> {
  const providerType = row.providerType || "default";
  if (isAppProviderId(providerType)) {
    const choice = await resolveAppProvider(apps, "fraud", providerType);
    if (!choice.provider) throw new ServiceUnavailableError(choice.issue);
    return choice.provider;
  }
  assertFraudProviderUrl(row.apiUrl);
  return bindProvider("fraud", builtInFraudChecker(providerType), {
    apiUrl: row.apiUrl,
    apiKey: row.apiKey,
    apiSecret: row.apiSecret,
    userId: row.userId,
  });
}

/**
 * Test a provider connection: its own testConnection, else a lookup of a
 * test number.
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

  try {
    const provider = await fraudProviderFor(row, apps);
    if (provider.testConnection) {
      const result = await provider.testConnection({}, {});
      return { success: result.ok, message: result.message };
    }
    await provider.check({ phone: TEST_PHONE }, {});
    return { success: true, message: "Connection successful" };
  } catch (error: unknown) {
    return {
      success: false,
      message:
        error instanceof Error ? error.message : "Connection failed",
    };
  }
}

/**
 * What a lookup gives: the provider's check, or, when the buyer is in a
 * country the provider does not know (MARKETS-DESIGN step 3a), no call at all
 * and the reason. A Bangladesh courier-history service is never asked about
 * a buyer elsewhere.
 */
export type FraudLookupResult =
  | { status: "checked"; check: FraudCheck }
  | { status: "country_unsupported"; provider: string; countryCode: string | null };

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
  const provider = await fraudProviderFor(row, apps);
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
