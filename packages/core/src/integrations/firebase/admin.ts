import { randomInteger } from "@scalius/shared/random";
// src/lib/firebase/admin.ts
// FCM REST API implementation for Cloudflare Workers
// Replaces firebase-admin SDK with direct HTTP calls

import { ServiceUnavailableError, ValidationError } from "@scalius/core/errors";

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Parallel FCM sends per multicast. Fixed; not merchant- or env-tunable. */
export const FCM_SEND_CONCURRENCY = 8;
/** Per-instance reuse of the OAuth access token (Google issues it for an hour). */
const FCM_ACCESS_TOKEN_REUSE_SECONDS = 3300;

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
    headers?: { Topic: string };
  };
  android?: { collapse_key: string };
  apns?: { headers: { "apns-collapse-id": string } };
  token: string;
}

interface FCMResponse {
  name?: string;
  /** `errorCode` is the `FcmError` detail (QUOTA_EXCEEDED, UNREGISTERED, UNAVAILABLE...). */
  error?: { code: number; message: string; status: string; errorCode?: string };
}

// Type definitions for FCM API responses
interface FCMSuccessResponse {
  name: string;
}

/**
 * Reads FCM's error body: `{ error: { code, message, status, details: [{ "@type":
 * ".../google.firebase.fcm.v1.FcmError", errorCode }] } }`. A body that is not JSON
 * (a gateway page) keeps only the HTTP status.
 */
async function readFcmError(response: Response): Promise<NonNullable<FCMResponse["error"]>> {
  let error: { message?: unknown; status?: unknown; details?: unknown } | undefined;
  try {
    const parsed = JSON.parse(await response.text()) as { error?: typeof error };
    error = parsed.error && typeof parsed.error === "object" ? parsed.error : undefined;
  } catch {
    error = undefined;
  }
  const detail = Array.isArray(error?.details)
    ? (error.details as Array<{ errorCode?: unknown } | null>).find((entry) => typeof entry?.errorCode === "string")
    : undefined;
  return {
    code: response.status,
    message: typeof error?.message === "string" && error.message ? error.message : "Unknown FCM error",
    status: typeof error?.status === "string" && error.status ? error.status : "UNKNOWN",
    ...(typeof detail?.errorCode === "string" ? { errorCode: detail.errorCode } : {}),
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
    // FCM takes no idempotency key: only a quota rejection (429) and a 503
    // ("not processed") prove nothing was sent. Any other server error or a
    // lost answer may follow a delivered message, so it is answered at once and
    // never sent again. A message carrying a collapse key also replaces a
    // still-queued first copy.
    const isRetryable = response.status === 429 || response.status === 503;

    if (response.ok) {
      const responseData = (await response.json()) as FCMSuccessResponse;
      return responseData;
    }

    if (isRetryable && attempt < MAX_RETRIES) {
      const retryAfter = response.headers.get("Retry-After");
      let delay = 2 ** attempt * 1000 + randomJitterMs(1000);
      const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : Number.NaN;
      if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
        delay = retryAfterSeconds * 1000;
      }
      console.warn(
        `FCM API returned retryable status ${response.status}. Retrying in ${delay}ms... (Attempt ${attempt}/${MAX_RETRIES})`,
      );
      await sleep(delay);
      continue;
    }

    return { error: await readFcmError(response) };
  }

  return {
    error: {
      code: 429,
      message: "Exceeded max retries for FCM request.",
      status: "QUOTA_EXCEEDED",
    },
  };
}

function randomJitterMs(maxMs: number): number {
  if (maxMs <= 0) {
    return 0;
  }

  const runtimeCrypto = crypto;
  if (!runtimeCrypto?.getRandomValues) {
    return 0;
  }

  return randomInteger(maxMs);
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

/**
 * Parses the service account JSON read from the encrypted `firebase` settings
 * row. The dashboard is the only source; there is no environment fallback.
 */
function initializeFCMService(serviceAccountJson?: string) {
  if (!serviceAccountJson || !serviceAccountJson.trim()) {
    throw new ServiceUnavailableError(
      "Firebase service account is not configured. Save it in the dashboard notification settings.",
    );
  }

  // Tolerate a pasted value wrapped in quotes.
  let jsonStr = serviceAccountJson.trim();
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
  private accessTokenCache: { token: string; expiresAt: number } | null = null;

  constructor(_environment: Record<string, unknown>, serviceAccountJson?: string) {
    const { serviceAccount, projectId } = initializeFCMService(serviceAccountJson);
    this.serviceAccount = serviceAccount;
    this.projectId = projectId;
  }

  private async ensureValidAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessTokenCache && this.accessTokenCache.expiresAt > now) {
      return this.accessTokenCache.token;
    }

    const newAccessToken = await getAccessToken(this.serviceAccount);
    this.rememberAccessToken(newAccessToken);
    return newAccessToken;
  }

  private rememberAccessToken(accessToken: string): void {
    this.accessTokenCache = {
      token: accessToken,
      expiresAt: Date.now() + FCM_ACCESS_TOKEN_REUSE_SECONDS * 1000,
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
    /** One key per push event (`pushCollapseKey`): a repeat replaces a queued first copy. */
    collapseKey?: string;
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
      FCM_SEND_CONCURRENCY,
      async (token) => {
        try {
          const message: FCMMessage = {
            token,
            notification: payload.notification,
            data: payload.data,
            ...(payload.collapseKey
              ? {
                android: { collapse_key: payload.collapseKey },
                apns: { headers: { "apns-collapse-id": payload.collapseKey } },
              }
              : {}),
            ...(payload.webpush || payload.collapseKey
              ? { webpush: { ...payload.webpush, ...(payload.collapseKey ? { headers: { Topic: payload.collapseKey } } : {}) } }
              : {}),
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
                code: this.mapErrorCode(response.error),
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

  /**
   * The FcmError detail names the failure best; the status and the HTTP code
   * cover a body without one. `server-unavailable` is only HTTP 503, the one
   * server answer FCM documents as not processed.
   */
  private mapErrorCode(error: { code: number; status: string; errorCode?: string }): string {
    const names = [error.errorCode, error.status].filter((name): name is string => Boolean(name));
    for (const name of names) {
      switch (name) {
        case "INVALID_ARGUMENT":
          return "messaging/invalid-argument";
        case "UNREGISTERED":
        case "NOT_FOUND":
          return "messaging/registration-token-not-registered";
        case "SENDER_ID_MISMATCH":
          return "messaging/mismatched-credential";
        case "QUOTA_EXCEEDED":
        case "RESOURCE_EXHAUSTED":
          return "messaging/message-rate-exceeded";
        case "UNAVAILABLE":
          if (error.code === 503) return "messaging/server-unavailable";
          break;
        case "INTERNAL":
          return "messaging/internal-error";
      }
    }
    if (error.code === 429) return "messaging/message-rate-exceeded";
    if (error.code === 503) return "messaging/server-unavailable";
    return "messaging/unknown-error";
  }
}

export function getFirebaseAdminMessaging(
  environment: Record<string, unknown>,
  serviceAccountJson?: string,
): FCMMessagingService {
  // The service retains its environment and access-token lookup state. Create
  // it per request.
  return new FCMMessagingService(environment, serviceAccountJson);
}
