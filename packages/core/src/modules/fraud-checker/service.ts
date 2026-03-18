// src/modules/fraud-checker/service.ts
// Fraud checker provider management and phone lookup service.
// Moved from src/lib/fraud-checker/service.ts.

import { settings } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  NotFoundError,
  ValidationError,
  ServiceUnavailableError,
} from "@scalius/core/errors";
import { getFraudCheckProvider } from "./provider";
import type { FraudCheckResult as ProviderFraudCheckResult } from "./provider";

export interface FraudCheckerProvider {
  id: string;
  name: string;
  apiUrl: string;
  apiKey: string;
  isActive: boolean;
  /** Optional provider type key — defaults to "default". */
  providerType?: string;
}

export interface FraudCheckResult {
  success: boolean;
  data?: {
    mobile_number: string;
    total_parcels: number;
    total_delivered: number;
    total_cancel: number;
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

export class FraudCheckerService {
  constructor(private db: Database) {}

  /**
   * Get all fraud checker providers
   */
  async getProviders(): Promise<FraudCheckerProvider[]> {
    const providerSettings = await this.db
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
  async getProvider(id: string): Promise<FraudCheckerProvider | null> {
    const [setting] = await this.db
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
  async saveProvider(
    provider: Omit<FraudCheckerProvider, "id"> & { id?: string },
  ): Promise<FraudCheckerProvider> {
    if (!provider.name || !provider.apiUrl || !provider.apiKey) {
      throw new ValidationError("Missing required fields: name, apiUrl, apiKey");
    }

    const providerId = provider.id || nanoid();
    const now = new Date();

    const providerData = {
      name: provider.name,
      apiUrl: provider.apiUrl,
      apiKey: provider.apiKey,
      isActive: provider.isActive,
      providerType: provider.providerType ?? "default",
    };

    // Check if provider exists
    const existing = await this.getProvider(providerId);

    if (existing) {
      // Update
      await this.db
        .update(settings)
        .set({
          value: JSON.stringify(providerData),
          updatedAt: now,
        })
        .where(
          and(eq(settings.category, CATEGORY), eq(settings.key, providerId)),
        );
    } else {
      // Create
      await this.db.insert(settings).values({
        id: nanoid(),
        key: providerId,
        category: CATEGORY,
        type: "json",
        value: JSON.stringify(providerData),
        updatedAt: now,
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
  async deleteProvider(id: string): Promise<boolean> {
    const existing = await this.getProvider(id);
    if (!existing) {
      throw new NotFoundError(`Fraud checker provider "${id}" not found`);
    }

    await this.db
      .delete(settings)
      .where(and(eq(settings.category, CATEGORY), eq(settings.key, id)));
    return true;
  }

  /**
   * Test a provider connection
   */
  async testProvider(
    id: string,
  ): Promise<{ success: boolean; message: string }> {
    const provider = await this.getProvider(id);
    if (!provider) {
      throw new NotFoundError(`Fraud checker provider "${id}" not found`);
    }

    try {
      const result = await this.lookup(provider, "01700000000");
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
  async lookup(
    provider: FraudCheckerProvider,
    phone: string,
  ): Promise<FraudCheckResult> {
    const checkProvider = getFraudCheckProvider(
      provider.providerType ?? "default",
    );

    try {
      const result = await checkProvider.lookup(
        phone,
        provider.apiUrl,
        provider.apiKey,
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
  async lookupWithActiveProvider(phone: string): Promise<FraudCheckResult> {
    const providers = await this.getProviders();
    const activeProvider = providers.find((p) => p.isActive);

    if (!activeProvider) {
      throw new NotFoundError(
        "No active fraud checker provider configured",
      );
    }

    return this.lookup(activeProvider, phone);
  }
}
