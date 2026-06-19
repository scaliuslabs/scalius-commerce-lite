// src/modules/fraud-checker/fraud-checker.service.ts
// Fraud checker provider management and phone lookup service.
// Moved from src/lib/fraud-checker/service.ts.

import { settings } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { eq, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { decryptCredentialsGraceful, encryptCredentials } from "@scalius/core/utils/credential-encryption";
import {
  NotFoundError,
  ValidationError,
  ServiceUnavailableError,
} from "@scalius/core/errors";
import {
  getFraudCheckProvider,
  getFraudCheckProviderDefinition,
  isFraudCheckProviderType,
} from "./provider";
import type {
  FraudCheckProviderType,
  FraudCheckResult as ProviderFraudCheckResult,
} from "./provider";

export interface FraudCheckerProvider {
  id: string;
  name: string;
  apiUrl: string;
  apiKey: string;
  apiSecret?: string;
  userId?: string;
  isActive: boolean;
  /** Optional provider type key — defaults to "default". */
  providerType?: FraudCheckProviderType;
}

export interface FraudCheckResult {
  success: boolean;
  data?: {
    mobile_number: string;
    total_parcels: number;
    total_delivered: number;
    total_cancel: number;
    provider_status?: string;
    message?: string;
    customer_tag?: string;
    success_rate?: number;
    cancel_rate?: number;
    apis?: Record<
      string,
      {
        total_parcels: number;
        total_delivered_parcels: number;
        total_cancelled_parcels: number;
      }
    >;
  };
  riskLevel?: ProviderFraudCheckResult["riskLevel"];
  error?: string;
}

const CATEGORY = "fraud-checker";

async function parseStoredProvider(
  value: string,
  encryptionKey?: string,
): Promise<Omit<FraudCheckerProvider, "id"> | null> {
  try {
    return JSON.parse(await decryptCredentialsGraceful(value, encryptionKey));
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
): Promise<FraudCheckerProvider[]> {
  const providerSettings = await db
    .select()
    .from(settings)
    .where(eq(settings.category, CATEGORY));

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

/**
 * Save a fraud checker provider (create or update)
 */
export async function saveFraudProvider(
  db: Database,
  provider: Omit<FraudCheckerProvider, "id"> & { id?: string },
  encryptionKey: string,
): Promise<FraudCheckerProvider> {
  if (!encryptionKey) {
    throw new ServiceUnavailableError("CREDENTIAL_ENCRYPTION_KEY is required to store provider credentials.");
  }

  const providerType = provider.providerType ?? "default";
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

  const providerId = provider.id || nanoid();

  const providerData = {
    name: provider.name,
    apiUrl: provider.apiUrl,
    apiKey: provider.apiKey,
    ...(provider.apiSecret ? { apiSecret: provider.apiSecret } : {}),
    ...(provider.userId ? { userId: provider.userId } : {}),
    isActive: provider.isActive,
    providerType,
  };
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
 * Test a provider connection
 */
export async function testFraudProvider(
  db: Database,
  id: string,
  encryptionKey?: string,
): Promise<{ success: boolean; message: string }> {
  const provider = await getFraudProvider(db, id, encryptionKey);
  if (!provider) {
    throw new NotFoundError(`Fraud checker provider "${id}" not found`);
  }

  try {
    const result = await fraudLookup(provider, "+8801700000000");
    return {
      success: result.success,
      message: result.success
        ? "Connection successful"
        : result.error || "Connection failed",
    };
  } catch (error: unknown) {
    return {
      success: false,
      message:
        error instanceof Error ? error.message : "Connection failed",
    };
  }
}

/**
 * Lookup fraud data for a phone number using a specific provider
 */
export async function fraudLookup(
  provider: FraudCheckerProvider,
  phone: string,
): Promise<FraudCheckResult> {
  const checkProvider = getFraudCheckProvider(
    provider.providerType ?? "default",
  );

  try {
    const result = await checkProvider.lookup(
      phone,
      {
        apiUrl: provider.apiUrl,
        apiKey: provider.apiKey,
        apiSecret: provider.apiSecret,
        userId: provider.userId,
      },
    );

    return {
      success: true,
      riskLevel: result.riskLevel,
      data: result.details as FraudCheckResult["data"],
    };
  } catch (error: unknown) {
    throw new ServiceUnavailableError(
      error instanceof Error ? error.message : "Fraud check lookup failed",
    );
  }
}

/**
 * Lookup fraud data using the first active provider
 */
export async function fraudLookupWithActiveProvider(
  db: Database,
  phone: string,
  encryptionKey?: string,
): Promise<FraudCheckResult> {
  const providers = await getFraudProviders(db, encryptionKey);
  const activeProvider = providers.find((p) => p.isActive);

  if (!activeProvider) {
    throw new NotFoundError(
      "No active fraud checker provider configured",
    );
  }

  return fraudLookup(activeProvider, phone);
}
