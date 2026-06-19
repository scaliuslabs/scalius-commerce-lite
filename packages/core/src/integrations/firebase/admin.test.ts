import { afterEach, describe, expect, it, vi } from "vitest";
import { FCMMessagingService } from "./admin";
import { decryptCredentials } from "../../utils/credential-encryption";

const credentialKey = Buffer.alloc(32, 23).toString("base64");

const serviceAccountJson = JSON.stringify({
  client_email: "firebase-adminsdk@example.iam.gserviceaccount.com",
  private_key: "unused-when-access-token-is-cached",
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

  it("sends multicast messages with bounded concurrency while preserving token response order", async () => {
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const sentTokens: string[] = [];
    const cache = {
      get: vi.fn(async () => "cached-token"),
      put: vi.fn(),
    };

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
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

    const messaging = new FCMMessagingService({
      FIREBASE_SERVICE_ACCOUNT_CRED_JSON: serviceAccountJson,
      FCM_SEND_CONCURRENCY: "2",
      PROJECT_CACHE_PREFIX: "test",
      SHARED_AUTH_CACHE: cache,
      CREDENTIAL_ENCRYPTION_KEY: credentialKey,
    });

    const result = await messaging.sendEachForMulticast({
      tokens: ["token-1", "bad-token", "token-3", "token-4"],
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

    expect(cache.get).toHaveBeenCalledWith("test:fcm_access_token:scalius-test");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(maxActiveRequests).toBe(2);
    expect(sentTokens).toEqual(["token-1", "bad-token", "token-3", "token-4"]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Authorization: "Bearer cached-token",
        "Content-Type": "application/json",
      },
    });

    expect(result.successCount).toBe(3);
    expect(result.failureCount).toBe(1);
    expect(result.responses.map((response) => response.success)).toEqual([
      true,
      false,
      true,
      true,
    ]);
    expect(result.responses[0]?.messageId).toBe("projects/scalius-test/messages/token-1");
    expect(result.responses[1]?.error?.code).toBe(
      "messaging/registration-token-not-registered",
    );
  });

  it("encrypts fresh OAuth access tokens before writing the shared KV cache", async () => {
    const signableServiceAccountJson = await createSignableServiceAccountJson();
    const cache = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "fresh-oauth-token" }), {
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

    const messaging = new FCMMessagingService({
      FIREBASE_SERVICE_ACCOUNT_CRED_JSON: signableServiceAccountJson,
      PROJECT_CACHE_PREFIX: "test",
      SHARED_AUTH_CACHE: cache,
      CREDENTIAL_ENCRYPTION_KEY: credentialKey,
    });

    await messaging.sendEachForMulticast({ tokens: ["token-1"] });

    expect(cache.put).toHaveBeenCalledTimes(1);
    const putCalls = cache.put.mock.calls as unknown as Array<[
      string,
      string,
      { expirationTtl: number },
    ]>;
    const [cacheKey, storedValue, options] = putCalls[0] ?? [];
    expect(cacheKey).toBe("test:fcm_access_token:scalius-test");
    expect(storedValue).toMatch(/^enc:/);
    expect(storedValue).not.toContain("fresh-oauth-token");
    await expect(
      decryptCredentials(String(storedValue).slice("enc:".length), credentialKey),
    ).resolves.toBe("fresh-oauth-token");
    expect(options).toEqual({ expirationTtl: 3300 });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://fcm.googleapis.com/v1/projects/scalius-test/messages:send",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer fresh-oauth-token",
        }),
      }),
    );
  });

  it("does not persist OAuth access tokens to KV when credential encryption is unavailable", async () => {
    const signableServiceAccountJson = await createSignableServiceAccountJson();
    const cache = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    };
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

    const messaging = new FCMMessagingService({
      FIREBASE_SERVICE_ACCOUNT_CRED_JSON: signableServiceAccountJson,
      PROJECT_CACHE_PREFIX: "test",
      SHARED_AUTH_CACHE: cache,
    });

    await messaging.sendEachForMulticast({ tokens: ["token-1"] });
    await messaging.sendEachForMulticast({ tokens: ["token-2"] });

    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
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
