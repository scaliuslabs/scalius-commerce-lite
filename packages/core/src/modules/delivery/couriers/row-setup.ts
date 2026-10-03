// The setup of a courier whose credentials and options are saved on its
// delivery provider row (the built-in couriers). Credentials are strict-read
// with CREDENTIAL_ENCRYPTION_KEY when encrypted; legacy plaintext rows remain
// readable for migration. Readiness is the row's required fields plus its
// keyed live-test proof. Failures carry fixed text and log masked metadata
// only: never the decrypted value or a parser's quote of it.

import { readStoredCredentialStrict } from "@scalius/core/utils/credential-encryption";
import {
  getDeliveryProviderReadinessSummary,
  getDeliveryProviderSetupFingerprint,
} from "../provider-readiness";
import type { CourierRow, CourierSetup } from "./port";

/**
 * What may be said about a stored value that is not valid JSON: its kind and
 * the error's class, never its text. A V8 `SyntaxError` message quotes the
 * start of the input, and for credentials that input is the decrypted secret.
 */
function logUnreadable(provider: CourierRow, what: "credentials" | "config", error: unknown): void {
  console.error(`[delivery] stored provider ${what} are not valid JSON`, {
    providerType: provider.type,
    providerId: provider.id,
    errorName: error instanceof Error ? error.name : typeof error,
  });
}

function parseStored(provider: CourierRow, what: "credentials" | "config", value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch (error: unknown) {
    logUnreadable(provider, what, error);
    return { ok: false };
  }
}

export async function readRowCourierSetup<S>(
  provider: CourierRow,
  encryptionKey: string | undefined,
  toSettings: (credentials: unknown, config: unknown) => S,
): Promise<CourierSetup<S>> {
  const proof = {
    type: provider.type,
    config: provider.config,
    isActive: provider.isActive,
    lastTestAttemptAt: provider.lastTestAttemptAt,
    lastTestSuccessAt: provider.lastTestSuccessAt,
    lastTestFailureAt: provider.lastTestFailureAt,
    lastTestSuccessFingerprint: provider.lastTestSuccessFingerprint,
  };
  const read = await readStoredCredentialStrict(provider.credentials, encryptionKey, "Delivery provider credentials");
  if (read.error) {
    return {
      settings: null,
      // Fixed text naming the label and the missing or wrong key; no value.
      error: read.error,
      unreadable: true,
      fingerprint: null,
      readiness: getDeliveryProviderReadinessSummary({ ...proof, credentials: null, credentialsReadable: false }),
    };
  }

  const fingerprint = encryptionKey
    ? await getDeliveryProviderSetupFingerprint({ type: provider.type, credentials: read.value, config: provider.config }, encryptionKey)
      .catch(() => null)
    : null;
  const readiness = getDeliveryProviderReadinessSummary({ ...proof, credentials: read.value, currentFingerprint: fingerprint });

  const credentials = parseStored(provider, "credentials", read.value);
  if (!credentials.ok) {
    return {
      settings: null,
      error: "Invalid credentials format: the stored credentials are not valid JSON. Re-enter and save them in Delivery provider settings.",
      fingerprint,
      readiness,
    };
  }
  const config = parseStored(provider, "config", provider.config);
  if (!config.ok) {
    return {
      settings: null,
      error: "Invalid config format: the stored configuration is not valid JSON. Re-enter and save it in Delivery provider settings.",
      fingerprint,
      readiness,
    };
  }
  return { settings: toSettings(credentials.value, config.value), fingerprint, readiness };
}
