import { PathaoProvider } from "./providers/pathao";
import { SteadfastProvider } from "./providers/steadfast";
import { readStoredCredentialStrict } from "@scalius/core/utils/credential-encryption";
import type { Database } from "@scalius/database/client";
import { AppError, ValidationError, NotFoundError, ServiceUnavailableError } from "@scalius/core/errors";
import type { DeliveryProviderRecord, DeliveryProviderType } from "@scalius/database/schema";
import type { DeliveryProviderInterface } from "./provider";
import type {
  PathaoCredentials,
  PathaoConfig,
  SteadfastCredentials,
  SteadfastConfig,
} from "./types";

/**
 * What may be said about a stored value that is not valid JSON: its kind and
 * the error's class, never its text. A V8 `SyntaxError` message quotes the
 * start of the input, and for credentials that input is the decrypted secret.
 */
function logUnreadable(provider: DeliveryProviderRecord, what: "credentials" | "config", error: unknown): void {
  console.error(`[delivery] stored provider ${what} are not valid JSON`, {
    providerType: provider.type,
    providerId: provider.id,
    errorName: error instanceof Error ? error.name : typeof error,
  });
}

/** The typed errors raised here carry fixed text; anything else is never quoted. */
function safeMessage(error: unknown): string {
  return error instanceof AppError ? error.message : "an unexpected error occurred";
}

/**
 * Create the appropriate provider instance based on provider type.
 *
 * Credentials are strict-read with CREDENTIAL_ENCRYPTION_KEY when encrypted.
 * Legacy plaintext credentials remain readable during migration. Failures log
 * and return masked metadata only: never the decrypted text or a parser's
 * quote of it.
 */
export async function createProvider(
  provider: DeliveryProviderRecord,
  encryptionKey?: string,
  db?: Database,
): Promise<DeliveryProviderInterface> {
  try {
    // Parse JSON strings from database (decrypt if needed)
    let credentials, config;

    const credentialRead = await readStoredCredentialStrict(
      provider.credentials,
      encryptionKey,
      "Delivery provider credentials",
    );
    if (credentialRead.error) {
      // Fixed text naming the label and the missing or wrong key; no value.
      throw new ValidationError(`Invalid credentials format: ${credentialRead.error}`);
    }
    try {
      credentials = JSON.parse(credentialRead.value);
    } catch (credError: unknown) {
      logUnreadable(provider, "credentials", credError);
      throw new ValidationError(
        "Invalid credentials format: the stored credentials are not valid JSON. Re-enter and save them in Delivery provider settings.",
      );
    }

    try {
      config = JSON.parse(provider.config);
    } catch (configError: unknown) {
      logUnreadable(provider, "config", configError);
      throw new ValidationError(
        "Invalid config format: the stored configuration is not valid JSON. Re-enter and save it in Delivery provider settings.",
      );
    }

    switch (provider.type as DeliveryProviderType) {
      case "pathao":
        if (!db) throw new ValidationError("PathaoProvider requires a database instance");
        return new PathaoProvider(
          credentials as PathaoCredentials,
          config as PathaoConfig,
          db,
        );
      case "steadfast":
        return new SteadfastProvider(
          credentials as SteadfastCredentials,
          config as SteadfastConfig,
        );
      default:
        throw new NotFoundError(`Unsupported provider type: ${provider.type}`);
    }
  } catch (error: unknown) {
    console.error("[delivery] could not create provider", {
      providerType: provider.type,
      providerId: provider.id,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    throw new ServiceUnavailableError(`Failed to create provider: ${safeMessage(error)}`);
  }
}
