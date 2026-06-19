// src/lib/firebase/admin.ts
// FCM REST API implementation for Cloudflare Workers
// Replaces firebase-admin SDK with direct HTTP calls

import { ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import {
  decryptCredentials,
  decryptCredentialsGraceful,
  encryptCredentials,
} from "../../utils/credential-encryption";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_FCM_SEND_CONCURRENCY = 8;
const MAX_FCM_SEND_CONCURRENCY = 20;
const FCM_ACCESS_TOKEN_CACHE_TTL_SECONDS = 3300;
const ENCRYPTED_VALUE_PREFIX = "enc:";

function getEnv(contextEnv?: Record<string, unknown>) {
  if (contextEnv) {
    return contextEnv;
  }
  if (typeof process !== "undefined" && process.env) {
    return process.env;
  }
  throw new ServiceUnavailableError(
    "Environment variables not available - should be provided by runtime context",
  );
}

function getCredentialEncryptionKey(
  env: Record<string, unknown>,
): string | undefined {
  return env.CREDENTIAL_ENCRYPTION_KEY as string | undefined;
}

function getProjectCachePrefix(env: Record<string, unknown>): string {
  const prefix = env.PROJECT_CACHE_PREFIX;
  return typeof prefix === "string" && prefix.trim()
    ? prefix.trim()
    : "scalius";
}

async function readCachedAccessToken(
  storedValue: string,
  encryptionKey: string,
): Promise<string | undefined> {
  const trimmed = storedValue.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith(ENCRYPTED_VALUE_PREFIX)) {
    try {
      return await decryptCredentials(
        trimmed.slice(ENCRYPTED_VALUE_PREFIX.length),
        encryptionKey,
      );
    } catch (error: unknown) {
      console.warn(
        "[Firebase] Failed to decrypt cached FCM access token:",
        error instanceof Error ? error.message : error,
      );
      return undefined;
    }
  }

  return decryptCredentialsGraceful(trimmed, encryptionKey);
}

async function encodeCachedAccessToken(
  accessToken: string,
  encryptionKey: string,
): Promise<string> {
  return `${ENCRYPTED_VALUE_PREFIX}${await encryptCredentials(
    accessToken,
    encryptionKey,
  )}`;
}

function base64UrlEncode(str: string): string {
  const encoded = new TextEncoder().encode(str);
  return btoa(String.fromCharCode.apply(null, Array.from(encoded)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function createJWT(serviceAccount: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const privateKeyPem = serviceAccount.private_key;
  let cryptoKey;
  try {
    const privateKeyBuffer = pemToArrayBuffer(privateKeyPem);
    cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      privateKeyBuffer,
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
      },
      false,
      ["sign"],
    );
  } catch (error: unknown) {
    console.error("Failed to import private key:", error);
    throw new ServiceUnavailableError(
      `Private key import failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsignedToken),
  );

  const encodedSignature = btoa(
    String.fromCharCode.apply(null, Array.from(new Uint8Array(signature))),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  return `${unsignedToken}.${encodedSignature}`;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const pemContents = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  try {
    const binaryString = atob(pemContents);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  } catch (e: unknown) {
    console.error("Failed to decode base64 PEM key:", e);
    throw new ValidationError("Invalid PEM private key format. Check your secret value.");
  }
}

async function getAccessToken(serviceAccount: ServiceAccount): Promise<string> {
  const jwt = await createJWT(serviceAccount);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error("Google OAuth Error:", error);
    throw new ServiceUnavailableError(`Failed to get access token: ${error}`);
  }

  const tokenData: { access_token: string } = await response.json();
  return tokenData.access_token;
}

interface FCMMessage {
  notification?: { title?: string; body?: string; image?: string };
  data?: { [key: string]: string };
  webpush?: {
    fcmOptions?: { link?: string };
    notification?: { badge?: string };
  };
  token: string;
}

interface FCMResponse {
  name?: string;
  error?: { code: number; message: string; status: string };
}

// Type definitions for FCM API responses
interface FCMSuccessResponse {
  name: string;
}
interface FCMErrorResponse {
  error: {
    code: number;
    message: string;
    status: string;
    details: unknown[];
  };
}

async function sendFCMMessage(
  accessToken: string,
  projectId: string,
  message: FCMMessage,
): Promise<FCMResponse> {
  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  const options = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message }),
  };

  const MAX_RETRIES = 3;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    attempt++;
    const response = await fetch(url, options);
    const isRetryable = response.status === 429 || response.status >= 500;

    if (response.ok) {
      const responseData = (await response.json()) as FCMSuccessResponse;
      return responseData;
    }

    if (isRetryable && attempt < MAX_RETRIES) {
      const retryAfter = response.headers.get("Retry-After");
      let delay = 2 ** attempt * 1000 + randomJitterMs(1000);
      if (retryAfter) {
        delay = parseInt(retryAfter, 10) * 1000;
      }
      console.warn(
        `FCM API returned retryable status ${response.status}. Retrying in ${delay}ms... (Attempt ${attempt}/${MAX_RETRIES})`,
      );
      await sleep(delay);
      continue;
    }

    const responseData = (await response.json()) as FCMErrorResponse;
    return {
      error: {
        code: response.status,
        message: responseData.error?.message || "Unknown FCM error",
        status: responseData.error?.status || "UNKNOWN",
      },
    };
  }

  return {
    error: {
      code: 500,
      message: "Exceeded max retries for FCM request.",
      status: "MAX_RETRIES_EXCEEDED",
    },
  };
}

function randomJitterMs(maxMs: number): number {
  if (maxMs <= 0) {
    return 0;
  }

  const runtimeCrypto = globalThis.crypto;
  if (!runtimeCrypto?.getRandomValues) {
    return 0;
  }

  const values = runtimeCrypto.getRandomValues(new Uint32Array(1));
  return (values[0] ?? 0) % maxMs;
}

function resolveSendConcurrency(env: Record<string, unknown>): number {
  const raw = Number(env.FCM_SEND_CONCURRENCY);
  if (!Number.isFinite(raw)) {
    return DEFAULT_FCM_SEND_CONCURRENCY;
  }

  return Math.max(
    1,
    Math.min(MAX_FCM_SEND_CONCURRENCY, Math.floor(raw)),
  );
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(items[currentIndex] as T, currentIndex);
      }
    }),
  );

  return results;
}

function initializeFCMService(environment?: Record<string, unknown>, serviceAccountJson?: string) {
  const env = getEnv(environment);
  const firebaseServiceAccountJson =
    serviceAccountJson || env.FIREBASE_SERVICE_ACCOUNT_CRED_JSON;

  if (!firebaseServiceAccountJson) {
    throw new ServiceUnavailableError(
      "FIREBASE_SERVICE_ACCOUNT_CRED_JSON is not set and no service account provided",
    );
  }

  // Sanitize the JSON string to handle common env var formatting issues
  // 1. Remove leading/trailing quotes if they exist (sometimes added by shell/env tools)
  let jsonStr = (firebaseServiceAccountJson as string).trim();
  if (jsonStr.startsWith('"') && jsonStr.endsWith('"')) {
    jsonStr = jsonStr.slice(1, -1);
  }

  try {
    let serviceAccount;
    // Attempt parse
    try {
      serviceAccount = JSON.parse(jsonStr);
    } catch (e: unknown) {
      // Retry with aggressive newline cleanup if first parse fails
      // This helps when newlines are literal instead of escaped \n
      try {
        const fixedJson = jsonStr.replace(/\n/g, "\\n");
        serviceAccount = JSON.parse(fixedJson);
      } catch {
        throw e; // Throw original error if both fail
      }
    }

    if (
      !serviceAccount.private_key ||
      !serviceAccount.client_email ||
      !serviceAccount.project_id
    ) {
      throw new ValidationError(
        "Firebase service account JSON is missing required fields",
      );
    }
    return {
      serviceAccount,
      projectId: serviceAccount.project_id,
    };
  } catch (error: unknown) {
    console.error("Error initializing FCM service:", error);
    throw new ServiceUnavailableError(
      `Failed to parse or initialize Firebase service account: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export class FCMMessagingService {
  private serviceAccount: ServiceAccount;
  private projectId: string;
  private env: Record<string, unknown>;
  private sendConcurrency: number;
  private accessTokenCache: { token: string; expiresAt: number } | null = null;

  constructor(environment: Record<string, unknown>, serviceAccountJson?: string) {
    const { serviceAccount, projectId } = initializeFCMService(
      environment,
      serviceAccountJson,
    );
    this.serviceAccount = serviceAccount;
    this.projectId = projectId;
    this.env = environment;
    this.sendConcurrency = resolveSendConcurrency(environment);
  }

  private async ensureValidAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessTokenCache && this.accessTokenCache.expiresAt > now) {
      return this.accessTokenCache.token;
    }

    const cacheKey = `${getProjectCachePrefix(this.env)}:fcm_access_token:${this.projectId}`;
    const cache = this.env.SHARED_AUTH_CACHE as KVNamespace | undefined;
    const encryptionKey = getCredentialEncryptionKey(this.env);

    if (cache && encryptionKey) {
      try {
        const cachedToken = await cache.get(cacheKey);
        if (cachedToken) {
          const accessToken = await readCachedAccessToken(cachedToken, encryptionKey);
          if (accessToken) {
            this.rememberAccessToken(accessToken);
            return accessToken;
          }
        }
      } catch (error: unknown) {
        console.warn(
          "[Firebase] Failed to read cached FCM access token:",
          error instanceof Error ? error.message : error,
        );
      }
    }

    const newAccessToken = await getAccessToken(this.serviceAccount);
    this.rememberAccessToken(newAccessToken);

    if (cache && encryptionKey) {
      try {
        await cache.put(cacheKey, await encodeCachedAccessToken(newAccessToken, encryptionKey), {
          expirationTtl: FCM_ACCESS_TOKEN_CACHE_TTL_SECONDS,
        });
      } catch (error: unknown) {
        console.warn(
          "[Firebase] Failed to write encrypted FCM access token cache:",
          error instanceof Error ? error.message : error,
        );
      }
    }

    return newAccessToken;
  }

  private rememberAccessToken(accessToken: string): void {
    this.accessTokenCache = {
      token: accessToken,
      expiresAt: Date.now() + FCM_ACCESS_TOKEN_CACHE_TTL_SECONDS * 1000,
    };
  }

  // ... (keep sendEachForMulticast and mapErrorCode same)
  async sendEachForMulticast(payload: {
    notification?: { title?: string; body?: string; image?: string };
    data?: { [key: string]: string };
    webpush?: {
      fcmOptions?: { link?: string };
      notification?: { badge?: string };
    };
    tokens: string[];
  }): Promise<{
    successCount: number;
    failureCount: number;
    responses: Array<{
      success: boolean;
      messageId?: string;
      error?: { code: string; message: string };
    }>;
  }> {
    const accessToken = await this.ensureValidAccessToken();
    const responses = await mapWithConcurrency(
      payload.tokens,
      this.sendConcurrency,
      async (token) => {
        try {
          const message: FCMMessage = {
            token,
            notification: payload.notification,
            data: payload.data,
            webpush: payload.webpush,
          };
          const response = await sendFCMMessage(
            accessToken,
            this.projectId,
            message,
          );

          if (response.error) {
            return {
              success: false,
              error: {
                code: this.mapErrorCode(response.error.status),
                message: response.error.message,
              },
            };
          }

          return { success: true, messageId: response.name };
        } catch (error: unknown) {
          return {
            success: false,
            error: {
              code: "messaging/unknown-error",
              message: error instanceof Error ? error.message : "Unknown error",
            },
          };
        }
      },
    );

    const successCount = responses.filter((response) => response.success).length;
    const failureCount = responses.length - successCount;
    return { successCount, failureCount, responses };
  }

  private mapErrorCode(status: string): string {
    switch (status) {
      case "INVALID_ARGUMENT":
        return "messaging/invalid-argument";
      case "UNREGISTERED":
        return "messaging/registration-token-not-registered";
      case "SENDER_ID_MISMATCH":
        return "messaging/mismatched-credential";
      case "QUOTA_EXCEEDED":
        return "messaging/message-rate-exceeded";
      case "UNAVAILABLE":
        return "messaging/server-unavailable";
      case "INTERNAL":
        return "messaging/internal-error";
      default:
        return "messaging/unknown-error";
    }
  }
}

// Singleton instance to prevent re-parsing JSON on every request
let fcmInstance: FCMMessagingService | null = null;

export function getFirebaseAdminMessaging(
  environment: Record<string, unknown>,
  serviceAccountJson?: string,
): FCMMessagingService {
  // If a specific service account is provided, we might want to bypass singleton or handle it differently.
  // For now, if provided, we assume it's the intended source and create a new instance if needed,
  // or just recreate if it differs. To keep it simple and safe for dynamic updates:
  // If serviceAccountJson is provided, ALWAYS return a new instance or reuse if matches (too complex to check match).
  // Let's just create a new one if credentials are provided, or fallback to singleton if not (legacy/env var mode).

  if (serviceAccountJson) {
    return new FCMMessagingService(environment, serviceAccountJson);
  }

  if (!fcmInstance) {
    fcmInstance = new FCMMessagingService(environment);
  }
  return fcmInstance;
}
