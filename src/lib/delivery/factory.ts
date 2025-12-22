import { PathaoProvider } from "./providers/pathao";
import { SteadfastProvider } from "./providers/steadfast";
import type { DeliveryProvider, DeliveryProviderType } from "@/db/schema";
import type { DeliveryProviderInterface } from "./provider";
import type {
  PathaoCredentials,
  PathaoConfig,
  SteadfastCredentials,
  SteadfastConfig,
} from "./types";

/**
 * Create the appropriate provider instance based on provider type
 */
export function createProvider(
  provider: DeliveryProvider,
): DeliveryProviderInterface {
  try {
    console.log(
      `Creating provider instance for: ${provider.name} (${provider.type})`,
    );

    // Parse JSON strings from database
    let credentials, config;

    try {
      credentials = JSON.parse(provider.credentials);
      console.log(`Parsed credentials for ${provider.type} provider`);
    } catch (credError) {
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
      console.log(`Parsed config for ${provider.type} provider`);
    } catch (configError) {
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
        console.log(
          `Creating Pathao provider with baseUrl: ${credentials.baseUrl}`,
        );
        return new PathaoProvider(
          credentials as PathaoCredentials,
          config as PathaoConfig,
        );
      case "steadfast":
        console.log(
          `Creating Steadfast provider with baseUrl: ${credentials.baseUrl}`,
        );
        return new SteadfastProvider(
          credentials as SteadfastCredentials,
          config as SteadfastConfig,
        );
      default:
        throw new Error(`Unsupported provider type: ${provider.type}`);
    }
  } catch (error) {
    console.error(`Error creating provider:`, error);
    throw new Error(
      `Failed to create provider: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
