import { PathaoProvider } from "./providers/pathao";
import { SteadfastProvider } from "./providers/steadfast";
import { decryptCredentialsGraceful } from "@scalius/core/utils/credential-encryption";
import type { DeliveryProviderRecord, DeliveryProviderType } from "@scalius/database/schema";
import type { DeliveryProviderInterface } from "./provider";
import type {
  PathaoCredentials,
  PathaoConfig,
  SteadfastCredentials,
  SteadfastConfig,
} from "./types";

/**
 * Create the appropriate provider instance based on provider type.
 *
 * If an encryptionKey is provided, credentials are decrypted before parsing.
 * Graceful decryption allows plaintext credentials to work during migration.
 */
export async function createProvider(
  provider: DeliveryProviderRecord,
  encryptionKey?: string,
): Promise<DeliveryProviderInterface> {
  try {
    // Parse JSON strings from database (decrypt if needed)
    let credentials, config;

    try {
      const rawCreds = await decryptCredentialsGraceful(
        provider.credentials,
        encryptionKey,
      );
      credentials = JSON.parse(rawCreds);
    } catch (credError: unknown) {
      console.error(
        `Failed to parse credentials for ${provider.type} provider:`,
        credError,
      );
      throw new Error(
        `Invalid credentials format: ${credError instanceof Error ? credError.message : String(credError)}`,
      );
    }

    try {
      config = JSON.parse(provider.config);
    } catch (configError: unknown) {
      console.error(
        `Failed to parse config for ${provider.type} provider:`,
        configError,
      );
      throw new Error(
        `Invalid config format: ${configError instanceof Error ? configError.message : String(configError)}`,
      );
    }

    switch (provider.type as DeliveryProviderType) {
      case "pathao":
        return new PathaoProvider(
          credentials as PathaoCredentials,
          config as PathaoConfig,
        );
      case "steadfast":
        return new SteadfastProvider(
          credentials as SteadfastCredentials,
          config as SteadfastConfig,
        );
      default:
        throw new Error(`Unsupported provider type: ${provider.type}`);
    }
  } catch (error: unknown) {
    console.error(`Error creating provider:`, error);
    throw new Error(
      `Failed to create provider: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
