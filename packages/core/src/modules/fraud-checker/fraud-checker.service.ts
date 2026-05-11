// src/modules/fraud-checker/fraud-checker.service.ts
// Fraud checker provider management and phone lookup service.
// Moved from src/lib/fraud-checker/service.ts.

import { settings } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { eq, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
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

/**
 * Get all fraud checker providers
 */
export async function getFraudProviders(db: Database): Promise<FraudCheckerProvider[]> {
  const providerSettings = await db
    .select()
    .from(settings)
    .where(eq(settings.category, CATEGORY));

  return providerSettings
    .map((setting) => {
      try {
        const data = JSON.parse(setting.value);
        return {
          id: setting.key,
          ...data,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as FraudCheckerProvider[];
}

/**
 * Get a specific provider by ID
 */
export async function getFraudProvider(db: Database, id: string): Promise<FraudCheckerProvider | null> {
  const [setting] = await db
    .select()
    .from(settings)
    .where(and(eq(settings.category, CATEGORY), eq(settings.key, id)));

  if (!setting) return null;

  try {
    const data = JSON.parse(setting.value);
    return {
      id: setting.key,
      ...data,
    };
  } catch {
    return null;
  }
}

/**
 * Save a fraud checker provider (create or update)
 */
export async function saveFraudProvider(
  db: Database,
  provider: Omit<FraudCheckerProvider, "id"> & { id?: string },
): Promise<FraudCheckerProvider> {
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

  // Check if provider exists
  const existing = await getFraudProvider(db, providerId);

  if (existing) {
    // Update
    await db
      .update(settings)
      .set({
        value: JSON.stringify(providerData),
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
      value: JSON.stringify(providerData),
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
  const existing = await getFraudProvider(db, id);
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
): Promise<{ success: boolean; message: string }> {
  const provider = await getFraudProvider(db, id);
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
export async function fraudLookupWithActiveProvider(db: Database, phone: string): Promise<FraudCheckResult> {
  const providers = await getFraudProviders(db);
  const activeProvider = providers.find((p) => p.isActive);

  if (!activeProvider) {
    throw new NotFoundError(
      "No active fraud checker provider configured",
    );
  }

  return fraudLookup(activeProvider, phone);
}
