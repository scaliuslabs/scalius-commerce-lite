// src/lib/firebase/admin.ts
// FCM REST API implementation for Cloudflare Workers
// Replaces firebase-admin SDK with direct HTTP calls

import type { KVNamespace } from "@cloudflare/workers-types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function getEnv(contextEnv?: any) {
  if (contextEnv) {
    return contextEnv;
  }
  if (typeof process !== "undefined" && process.env) {
    return process.env;
  }
  throw new Error(
    "Environment variables not available - should be provided by runtime context",
  );
}

function base64UrlEncode(str: string): string {
  const encoded = new TextEncoder().encode(str);
  return btoa(String.fromCharCode.apply(null, Array.from(encoded)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function createJWT(serviceAccount: any): Promise<string> {
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
  } catch (error) {
    console.error("Failed to import private key:", error);
    throw new Error(
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
  } catch (e) {
    console.error("Failed to decode base64 PEM key:", e);
    throw new Error("Invalid PEM private key format. Check your secret value.");
  }
}

async function getAccessToken(serviceAccount: any): Promise<string> {
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
    throw new Error(`Failed to get access token: ${error}`);
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
    details: any[];
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
      let delay = 2 ** attempt * 1000 + Math.random() * 1000;
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

function initializeFCMService(environment?: any, serviceAccountJson?: string) {
  const env = getEnv(environment);
  const firebaseServiceAccountJson =
    serviceAccountJson || env.FIREBASE_SERVICE_ACCOUNT_CRED_JSON;

  if (!firebaseServiceAccountJson) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_CRED_JSON is not set and no service account provided",
    );
  }

  // Sanitize the JSON string to handle common env var formatting issues
  // 1. Remove leading/trailing quotes if they exist (sometimes added by shell/env tools)
  let jsonStr = firebaseServiceAccountJson.trim();
  if (jsonStr.startsWith('"') && jsonStr.endsWith('"')) {
    jsonStr = jsonStr.slice(1, -1);
  }

  try {
    let serviceAccount;
    // Attempt parse
    try {
      serviceAccount = JSON.parse(jsonStr);
    } catch (e) {
      // Retry with aggressive newline cleanup if first parse fails
      // This helps when newlines are literal instead of escaped \n
      try {
        const fixedJson = jsonStr.replace(/\n/g, "\\n");
        serviceAccount = JSON.parse(fixedJson);
      } catch (e2) {
        throw e; // Throw original error if both fail
      }
    }

    if (
      !serviceAccount.private_key ||
      !serviceAccount.client_email ||
      !serviceAccount.project_id
    ) {
      throw new Error(
        "Firebase service account JSON is missing required fields",
      );
    }
    return {
      serviceAccount,
      projectId: serviceAccount.project_id,
    };
  } catch (error) {
    console.error("Error initializing FCM service:", error);
    throw new Error(
      `Failed to parse or initialize Firebase service account: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export class FCMMessagingService {
  private serviceAccount: any;
  private projectId: string;
  private env: any;

  constructor(environment: any, serviceAccountJson?: string) {
    const { serviceAccount, projectId } = initializeFCMService(
      environment,
      serviceAccountJson,
    );
    this.serviceAccount = serviceAccount;
    this.projectId = projectId;
    this.env = environment;
  }

  private async ensureValidAccessToken(): Promise<string> {
    const cacheKey = `${this.env.PROJECT_CACHE_PREFIX}:fcm_access_token`;
    const cache = this.env.SHARED_AUTH_CACHE as KVNamespace | undefined;

    if (!cache) {
      // Warn once per instance
      // console.warn("SHARED_AUTH_CACHE KV namespace not bound. Bypassing cache.");
      return getAccessToken(this.serviceAccount);
    }

    const cachedToken = await cache.get(cacheKey);
    if (cachedToken) {
      return cachedToken;
    }

    console.log(
      `KV cache miss for [${cacheKey}]. Minting new Firebase access token...`,
    );
    try {
      const newAccessToken = await getAccessToken(this.serviceAccount);
      await cache.put(cacheKey, newAccessToken, { expirationTtl: 3300 });
      console.log(`Access token obtained and cached in KV for [${cacheKey}].`);
      return newAccessToken;
    } catch (error) {
      console.error("Failed to get or cache Firebase access token:", error);
      throw error;
    }
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
      error?: { code: string; message: string };
    }>;
  }> {
    const accessToken = await this.ensureValidAccessToken();
    const responses: Array<{
      success: boolean;
      error?: { code: string; message: string };
    }> = [];
    let successCount = 0;
    let failureCount = 0;

    for (const token of payload.tokens) {
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
          failureCount++;
          responses.push({
            success: false,
            error: {
              code: this.mapErrorCode(response.error.status),
              message: response.error.message,
            },
          });
        } else {
          successCount++;
          responses.push({ success: true });
        }
      } catch (error) {
        failureCount++;
        responses.push({
          success: false,
          error: {
            code: "messaging/unknown-error",
            message: error instanceof Error ? error.message : "Unknown error",
          },
        });
      }
    }
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
  environment: any,
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
