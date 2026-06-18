import { afterEach, describe, expect, it, vi } from "vitest";
import { FCMMessagingService } from "./admin";

const serviceAccountJson = JSON.stringify({
  client_email: "firebase-adminsdk@example.iam.gserviceaccount.com",
  private_key: "unused-when-access-token-is-cached",
  project_id: "scalius-test",
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

    expect(cache.get).toHaveBeenCalledWith("test:fcm_access_token");
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
    expect(result.responses[1]?.error?.code).toBe(
      "messaging/registration-token-not-registered",
    );
  });
});
