// Webhook signature verification for delivery provider webhooks.
// Supports HMAC-SHA256 signature verification and IP allowlist fallback.

import { eq } from "drizzle-orm";
import { deliveryProviders } from "@scalius/database/schema";
import { getDb } from "@scalius/database/client";
import { decryptCredentialsGraceful } from "@scalius/core/utils/credential-encryption";
import { getEncryptionKey } from "../utils/encryption-key";

interface WebhookVerificationResult {
  verified: boolean;
  /** null when no provider found; otherwise the parsed credentials */
  credentials: Record<string, unknown> | null;
  /** null when no provider found; otherwise the parsed config */
  config: Record<string, unknown> | null;
  /** Human-readable reason when verification fails */
  reason?: string;
}

/**
 * Compute HMAC-SHA256 of `body` using `secret` and return the hex digest.
 * Uses the Web Crypto API available in Cloudflare Workers.
 */
async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
  }
  return result === 0;
}

function parseWebhookObject(value: string, label: string, providerType: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(`[webhook-auth] [${providerType}] ${label} must be a JSON object`);
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (error: unknown) {
    console.warn(
      `[webhook-auth] [${providerType}] Invalid ${label} JSON:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Verify a delivery webhook request against the stored provider credentials.
 *
 * Verification strategy (in order):
 *  1. HMAC-SHA256 — if `credentials.webhookSecret` is set, the request body
 *     is signed and compared against the `X-Webhook-Signature` header.
 *  2. IP allowlist — if `config.allowedWebhookIps` is set, the request IP
 *     (from `CF-Connecting-IP` header) is checked against the list.
 *  3. No security configured — logs a warning and allows the request through
 *     for backward compatibility.
 */
export async function verifyDeliveryWebhook(
  env: Env,
  providerType: string,
  request: Request,
  rawBody: string,
): Promise<WebhookVerificationResult> {
  const db = getDb(env);

  // Look up the active provider by type
  const provider = await db
    .select()
    .from(deliveryProviders)
    .where(eq(deliveryProviders.type, providerType))
    .get();

  if (!provider) {
    console.warn(`[webhook-auth] No provider found for type: ${providerType}`);
    return { verified: false, credentials: null, config: null, reason: "Provider not configured" };
  }

  const encryptionKey = getEncryptionKey(env as Record<string, unknown>);
  const rawCreds = provider.credentials
    ? await decryptCredentialsGraceful(provider.credentials, encryptionKey)
    : "{}";
  const credentials = parseWebhookObject(rawCreds, "credentials", providerType);
  if (!credentials) {
    return {
      verified: false,
      credentials: null,
      config: null,
      reason: "Invalid provider credentials",
    };
  }

  const config = provider.config
    ? parseWebhookObject(provider.config, "config", providerType)
    : {};
  if (!config) {
    return {
      verified: false,
      credentials,
      config: null,
      reason: "Invalid provider config",
    };
  }

  // --- Strategy 1: Provider-specific signature/token verification ---
  const webhookSecret = (credentials.webhookSecret ?? credentials.secretKey) as string | undefined;

  if (webhookSecret) {
    switch (providerType) {
      // Pathao sends the merchant-configured secret as X-PATHAO-Signature header
      case "pathao": {
        const pathaoSig = request.headers.get("X-PATHAO-Signature");
        if (!pathaoSig) {
          console.warn(`[webhook-auth] [pathao] Missing X-PATHAO-Signature header`);
          return {
            verified: false,
            credentials,
            config,
            reason: "Missing X-PATHAO-Signature header",
          };
        }

        if (!timingSafeEqual(pathaoSig, webhookSecret)) {
          console.warn(`[webhook-auth] [pathao] Invalid X-PATHAO-Signature`);
          return {
            verified: false,
            credentials,
            config,
            reason: "Invalid X-PATHAO-Signature",
          };
        }

        return { verified: true, credentials, config };
      }

      // Steadfast sends Authorization: Bearer {token} header
      case "steadfast": {
        const authHeader = request.headers.get("Authorization") || "";
        // Case-insensitive check for "Bearer " prefix (defensive)
        if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
          console.warn(`[webhook-auth] [steadfast] Missing or invalid Authorization header`);
          return {
            verified: false,
            credentials,
            config,
            reason: "Missing Authorization Bearer token",
          };
        }

        const token = authHeader.slice(7).trim(); // strip "Bearer " (case-insensitive)
        if (!timingSafeEqual(token, webhookSecret)) {
          console.warn(`[webhook-auth] [steadfast] Invalid Bearer token`);
          return {
            verified: false,
            credentials,
            config,
            reason: "Invalid Bearer token",
          };
        }

        return { verified: true, credentials, config };
      }

      // Generic fallback: HMAC-SHA256 via X-Webhook-Signature header
      default: {
        const signatureHeader = request.headers.get("X-Webhook-Signature");
        if (!signatureHeader) {
          console.warn(`[webhook-auth] [${providerType}] Missing X-Webhook-Signature header`);
          return {
            verified: false,
            credentials,
            config,
            reason: "Missing X-Webhook-Signature header",
          };
        }

        const expectedSignature = await hmacSha256Hex(webhookSecret, rawBody);

        // Support both raw hex and "sha256=<hex>" prefix formats
        const normalizedHeader = signatureHeader.startsWith("sha256=")
          ? signatureHeader.slice(7)
          : signatureHeader;

        if (!timingSafeEqual(normalizedHeader, expectedSignature)) {
          console.warn(`[webhook-auth] [${providerType}] Invalid webhook signature`);
          return {
            verified: false,
            credentials,
            config,
            reason: "Invalid webhook signature",
          };
        }

        return { verified: true, credentials, config };
      }
    }
  }

  // --- Strategy 2: IP allowlist fallback ---
  const allowedIps = config.allowedWebhookIps as string[] | undefined;
  if (allowedIps && allowedIps.length > 0) {
    const requestIp =
      request.headers.get("CF-Connecting-IP") ??
      request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
      null;

    if (!requestIp) {
      console.warn(`[webhook-auth] [${providerType}] Cannot determine request IP`);
      return {
        verified: false,
        credentials,
        config,
        reason: "Cannot determine request IP for allowlist check",
      };
    }

    if (!allowedIps.includes(requestIp)) {
      console.warn(
        `[webhook-auth] [${providerType}] IP ${requestIp} not in allowlist`,
      );
      return {
        verified: false,
        credentials,
        config,
        reason: `IP ${requestIp} not in allowed webhook IPs`,
      };
    }

    return { verified: true, credentials, config };
  }

  // --- Strategy 3: No security configured — REJECT ---
  console.error(
    `[webhook-auth] [${providerType}] REJECTED: No webhookSecret or allowedWebhookIps configured. ` +
    `Set credentials.webhookSecret or config.allowedWebhookIps for this provider.`,
  );

  return { verified: false, credentials, config, reason: "No webhook authentication configured for this provider" };
}
