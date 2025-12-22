import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";

export interface FraudCheckerProvider {
  id: string;
  name: string;
  apiUrl: string;
  apiKey: string;
  isActive: boolean;
}

export interface FraudCheckResult {
  success: boolean;
  data?: {
    mobile_number: string;
    total_parcels: number;
    total_delivered: number;
    total_cancel: number;
    apis?: Record<string, {
      total_parcels: number;
      total_delivered_parcels: number;
      total_cancelled_parcels: number;
    }>;
  };
  error?: string;
}

const CATEGORY = "fraud-checker";

export class FraudCheckerService {
  /**
   * Get all fraud checker providers
   */
  async getProviders(): Promise<FraudCheckerProvider[]> {
    const providerSettings = await db
      .select()
      .from(settings)
      .where(eq(settings.category, CATEGORY));

    return providerSettings.map((setting) => {
      try {
        const data = JSON.parse(setting.value);
        return {
          id: setting.key,
          ...data,
        };
      } catch {
        return null;
      }
    }).filter(Boolean) as FraudCheckerProvider[];
  }

  /**
   * Get a specific provider by ID
   */
  async getProvider(id: string): Promise<FraudCheckerProvider | null> {
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
  async saveProvider(provider: Omit<FraudCheckerProvider, "id"> & { id?: string }): Promise<FraudCheckerProvider> {
    const providerId = provider.id || nanoid();
    const now = new Date();

    const providerData = {
      name: provider.name,
      apiUrl: provider.apiUrl,
      apiKey: provider.apiKey,
      isActive: provider.isActive,
    };

    // Check if provider exists
    const existing = await this.getProvider(providerId);

    if (existing) {
      // Update
      await db
        .update(settings)
        .set({
          value: JSON.stringify(providerData),
          updatedAt: now,
        })
        .where(and(eq(settings.category, CATEGORY), eq(settings.key, providerId)));
    } else {
      // Create
      await db.insert(settings).values({
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
    await db
      .delete(settings)
      .where(and(eq(settings.category, CATEGORY), eq(settings.key, id)));
    return true;
  }

  /**
   * Test a provider connection
   */
  async testProvider(id: string): Promise<{ success: boolean; message: string }> {
    const provider = await this.getProvider(id);
    if (!provider) {
      return { success: false, message: "Provider not found" };
    }

    try {
      // Test with a dummy phone number
      const result = await this.lookup(provider, "01700000000");
      return {
        success: result.success,
        message: result.success ? "Connection successful" : result.error || "Connection failed",
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : "Connection failed",
      };
    }
  }

  /**
   * Lookup fraud data for a phone number using a specific provider
   */
  async lookup(provider: FraudCheckerProvider, phone: string): Promise<FraudCheckResult> {
    try {
      const formData = new FormData();
      formData.append("phone", phone);

      const response = await fetch(provider.apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const data = await response.json();
      return {
        success: true,
        data,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Lookup failed",
      };
    }
  }

  /**
   * Lookup fraud data using the first active provider
   */
  async lookupWithActiveProvider(phone: string): Promise<FraudCheckResult> {
    const providers = await this.getProviders();
    const activeProvider = providers.find((p) => p.isActive);

    if (!activeProvider) {
      return {
        success: false,
        error: "No active fraud checker provider configured",
      };
    }

    return this.lookup(activeProvider, phone);
  }
}
