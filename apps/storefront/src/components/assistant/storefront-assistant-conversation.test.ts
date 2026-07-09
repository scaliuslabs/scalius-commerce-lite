// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendStorefrontConversationMessage,
  createStorefrontConversationId,
  createStorefrontConversationRequestId,
  readStorefrontConversationEvents,
} from "./storefront-assistant-conversation";

const CONVERSATION_ID = "conv_abcdefghijklmnopqrstuv";

function messageEvent(sequence: number, role: "user" | "assistant") {
  return {
    eventId: `event_${sequence}`,
    sequence,
    type: "message.appended",
    occurredAt: 1_000 + sequence,
    message: {
      id: `message_${sequence}`,
      role,
      content: role === "user" ? "Find a shirt" : "Here is one option.",
      contextMarker: "storefront:product",
      createdAt: 1_000 + sequence,
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Storefront conversation browser client", () => {
  it("creates strong browser-only conversation and request identifiers", () => {
    expect(createStorefrontConversationId()).toMatch(
      /^conv_[A-Za-z0-9_-]{22}$/,
    );
    expect(createStorefrontConversationRequestId()).toMatch(
      /^message_[A-Za-z0-9_-]{22}$/,
    );
    expect(createStorefrontConversationRequestId("run")).toMatch(
      /^run_[A-Za-z0-9_-]{22}$/,
    );
  });

  it("appends canonical text through the same-origin credentialed facade", async () => {
    const event = messageEvent(1, "user");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        `/api/assistant/conversations/${CONVERSATION_ID}/messages`,
      );
      expect(init).toMatchObject({
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        mode: "same-origin",
        redirect: "error",
      });
      expect(new Headers(init?.headers).get("Content-Type")).toBe(
        "application/json",
      );
      await expect(new Response(init?.body).json()).resolves.toEqual({
        clientMessageId: "message_request_1",
        role: "user",
        content: "Find a shirt",
        contextMarker: "storefront:product",
      });
      return Response.json({
        success: true,
        protocolVersion: "2026-07-10",
        surface: "storefront",
        replayed: false,
        expiresAt: 100_000,
        event,
      }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(appendStorefrontConversationMessage(CONVERSATION_ID, {
      clientMessageId: "message_request_1",
      role: "user",
      content: "Find a shirt",
      contextMarker: "storefront:product",
    })).resolves.toEqual(event);
  });

  it("hydrates ordered message events while ignoring cancellation metadata", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      success: true,
      protocolVersion: "2026-07-10",
      surface: "storefront",
      conversation: {
        events: [
          messageEvent(1, "user"),
          {
            eventId: "event_cancel",
            sequence: 2,
            type: "stream.cancelled",
            occurredAt: 1_002,
            cancellation: { runHash: "a".repeat(64) },
          },
          messageEvent(3, "assistant"),
        ],
        cursor: 3,
        earliestCursor: 1,
        hasMore: false,
        expiresAt: 100_000,
        cancellation: null,
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const replay = await readStorefrontConversationEvents(CONVERSATION_ID, {
      after: 0,
      limit: 50,
    });

    expect(replay.events.map((event) => event.sequence)).toEqual([1, 3]);
    expect(replay.cursor).toBe(3);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/assistant/conversations/${CONVERSATION_ID}/events?after=0&limit=50`,
      expect.objectContaining({ credentials: "same-origin", mode: "same-origin" }),
    );
  });

  it("rejects malformed facade envelopes instead of rendering them", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      success: true,
      protocolVersion: "wrong",
      surface: "storefront",
      event: messageEvent(1, "assistant"),
    })));

    await expect(appendStorefrontConversationMessage(CONVERSATION_ID, {
      clientMessageId: "message_request_1",
      role: "user",
      content: "Unsafe response",
      contextMarker: "storefront:unknown",
    })).rejects.toMatchObject({
      code: "conversation_response_invalid",
      status: 502,
    });
  });
});
