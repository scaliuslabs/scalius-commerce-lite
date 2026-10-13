import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FCMMessagingService,
  FCM_SEND_CONCURRENCY,
  getFirebaseAdminMessaging,
} from "./admin";

const serviceAccountJson = JSON.stringify({
  client_email: "firebase-adminsdk@example.iam.gserviceaccount.com",
  private_key: "unused-by-validation-tests",
  project_id: "scalius-test",
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function createSignableServiceAccountJson() {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const privateKey = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const privateKeyBase64 = Buffer.from(privateKey).toString("base64");
  const pem = [
    "-----BEGIN PRIVATE KEY-----",
    ...(privateKeyBase64.match(/.{1,64}/g) ?? []),
    "-----END PRIVATE KEY-----",
  ].join("\n");

  return JSON.stringify({
    client_email: "firebase-adminsdk@example.iam.gserviceaccount.com",
    private_key: pem,
    project_id: "scalius-test",
  });
}

describe("FCMMessagingService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates request-scoped messaging services instead of retaining Worker bindings", () => {
    const firstEnvironment = {};
    const secondEnvironment = {};

    const first = getFirebaseAdminMessaging(firstEnvironment, serviceAccountJson);
    const sameEnvironment = getFirebaseAdminMessaging(firstEnvironment, serviceAccountJson);
    const second = getFirebaseAdminMessaging(secondEnvironment, serviceAccountJson);

    expect(sameEnvironment).not.toBe(first);
    expect(second).not.toBe(first);
  });

  it("requires the dashboard-managed service account and never reads it from env", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previous = process.env.FIREBASE_SERVICE_ACCOUNT_CRED_JSON;
    process.env.FIREBASE_SERVICE_ACCOUNT_CRED_JSON = serviceAccountJson;

    try {
      expect(() => new FCMMessagingService({
        FIREBASE_SERVICE_ACCOUNT_CRED_JSON: serviceAccountJson,
      })).toThrow("Firebase service account is not configured");
      expect(() => new FCMMessagingService({}, "   ")).toThrow(
        "Firebase service account is not configured",
      );
      expect(() => getFirebaseAdminMessaging({}, undefined)).toThrow(
        "Firebase service account is not configured",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.FIREBASE_SERVICE_ACCOUNT_CRED_JSON;
      } else {
        process.env.FIREBASE_SERVICE_ACCOUNT_CRED_JSON = previous;
      }
      errorSpy.mockRestore();
    }
  });

  it("rejects a service account that is missing required fields", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() => new FCMMessagingService({}, JSON.stringify({ project_id: "only" }))).toThrow(
        "Firebase service account JSON is missing required fields",
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("sends multicast messages with the fixed concurrency while preserving token response order", async () => {
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const sentTokens: string[] = [];
    const signableServiceAccountJson = await createSignableServiceAccountJson();

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "oauth-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);

      const body = JSON.parse(String(init?.body ?? "{}")) as {
        message?: { token?: string };
      };
      const token = body.message?.token ?? "";
      sentTokens.push(token);

      await delay(5);
      activeRequests -= 1;

      if (token === "bad-token") {
        return new Response(
          JSON.stringify({
            error: {
              code: 404,
              message: "Requested entity was not found.",
              status: "UNREGISTERED",
              details: [],
            },
          }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response(
        JSON.stringify({ name: `projects/scalius-test/messages/${token}` }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const messaging = new FCMMessagingService(
      {
        // Removed tunable: must be ignored.
        FCM_SEND_CONCURRENCY: "2",
      },
      signableServiceAccountJson,
    );

    const tokens = [
      "token-1",
      "bad-token",
      ...Array.from({ length: FCM_SEND_CONCURRENCY + 2 }, (_, index) => `token-${index + 3}`),
    ];
    const result = await messaging.sendEachForMulticast({
      tokens,
      notification: {
        title: "New order",
        body: "Order #1001",
      },
      data: {
        orderId: "1001",
      },
      webpush: {
        fcmOptions: {
          link: "/admin/orders/1001",
        },
      },
    });

    expect(FCM_SEND_CONCURRENCY).toBe(8);
    // One OAuth exchange, then one send per token.
    expect(fetchMock).toHaveBeenCalledTimes(tokens.length + 1);
    expect(maxActiveRequests).toBe(FCM_SEND_CONCURRENCY);
    expect(sentTokens).toEqual(tokens);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: {
        Authorization: "Bearer oauth-token",
        "Content-Type": "application/json",
      },
    });

    expect(result.successCount).toBe(tokens.length - 1);
    expect(result.failureCount).toBe(1);
    expect(result.responses.map((response) => response.success)).toEqual(
      tokens.map((token) => token !== "bad-token"),
    );
    expect(result.responses[0]?.messageId).toBe("projects/scalius-test/messages/token-1");
    expect(result.responses[1]?.error?.code).toBe(
      "messaging/registration-token-not-registered",
    );
  });

  it("reuses one OAuth access token across sends of the same service", async () => {
    const signableServiceAccountJson = await createSignableServiceAccountJson();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "uncached-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(
        JSON.stringify({ name: "projects/scalius-test/messages/token-1" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const messaging = new FCMMessagingService({}, signableServiceAccountJson);

    await messaging.sendEachForMulticast({ tokens: ["token-1"] });
    await messaging.sendEachForMulticast({ tokens: ["token-2"] });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const fetchCalls = fetchMock.mock.calls as Array<[
      RequestInfo | URL,
      RequestInit | undefined,
    ]>;
    expect(fetchCalls[1]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer uncached-token",
      }),
    });
    expect(fetchCalls[2]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer uncached-token",
      }),
    });
  });
});
