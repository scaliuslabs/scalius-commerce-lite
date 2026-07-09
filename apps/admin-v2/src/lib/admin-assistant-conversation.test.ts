import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_CONVERSATION_TRANSPORT,
  AdminConversationTransportError,
  appendAdminConversationMessage,
  cancelAdminConversationRun,
  createAdminConversationId,
  createAdminConversationRequestId,
  deleteAdminConversation,
  isAdminConversationId,
  pollAdminConversationEvents,
  readAdminConversationEvents,
} from "./admin-assistant-conversation";

const CONVERSATION_ID = "conv_abcdefghijklmnopqrstuv";
const RUN_HASH = "a".repeat(64);

function messageEvent(sequence = 1) {
  return {
    eventId: `event_${sequence}`,
    sequence,
    type: "message.appended" as const,
    occurredAt: 1_725_000_000_000 + sequence,
    message: {
      id: `message_${sequence}`,
      role: "user" as const,
      content: "Show me low-stock products",
      contextMarker: "admin:page" as const,
      createdAt: 1_725_000_000_000 + sequence,
    },
  };
}

function cancellationEvent(sequence = 2) {
  return {
    eventId: `event_${sequence}`,
    sequence,
    type: "stream.cancelled" as const,
    occurredAt: 1_725_000_000_000 + sequence,
    cancellation: { runHash: RUN_HASH },
  };
}

function successEnvelope(value: Record<string, unknown>) {
  return {
    success: true,
    protocolVersion: "2026-07-10",
    surface: "admin",
    ...value,
  };
}

function replayEnvelope(options: {
  events?: unknown[];
  cursor?: number;
  hasMore?: boolean;
} = {}) {
  return successEnvelope({
    conversation: {
      events: options.events ?? [],
      cursor: options.cursor ?? 0,
      earliestCursor: 0,
      hasMore: options.hasMore ?? false,
      expiresAt: 1_725_604_800_000,
      cancellation: null,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("admin conversation browser transport", () => {
  it("generates strong opaque identifiers and advertises polling-only support", () => {
    const identifiers = Array.from({ length: 20 }, () => createAdminConversationId());

    expect(new Set(identifiers).size).toBe(identifiers.length);
    for (const identifier of identifiers) {
      expect(identifier).toMatch(/^conv_[A-Za-z0-9_-]{22}$/);
      expect(isAdminConversationId(identifier)).toBe(true);
    }
    expect(createAdminConversationRequestId("message")).toMatch(
      /^message_[A-Za-z0-9_-]{22}$/,
    );
    expect(ADMIN_CONVERSATION_TRANSPORT).toEqual({
      polling: true,
      webSocket: false,
    });
  });

  it("appends through a relative same-origin URL without exposing the Agent origin", async () => {
    const event = messageEvent();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        `/api/assistant/conversations/${CONVERSATION_ID}/messages`,
      );
      expect(String(input)).not.toContain("admin-agent.internal");
      expect(init).toMatchObject({
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        mode: "same-origin",
        redirect: "error",
      });
      expect(new Headers(init?.headers)).toEqual(
        new Headers({ Accept: "application/json", "Content-Type": "application/json" }),
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        clientMessageId: "message_request_1",
        role: "user",
        content: "Show me low-stock products",
        contextMarker: "admin:page",
      });
      return Response.json(successEnvelope({
        replayed: false,
        event,
        expiresAt: 1_725_604_800_000,
      }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await appendAdminConversationMessage(CONVERSATION_ID, {
      clientMessageId: "message_request_1",
      role: "user",
      content: "Show me low-stock products",
      contextMarker: "admin:page",
    });

    expect(result).toEqual({
      replayed: false,
      event,
      expiresAt: 1_725_604_800_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads and validates replay events through bounded cursor query parameters", async () => {
    const events = [messageEvent(4), cancellationEvent(5)];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        `/api/assistant/conversations/${CONVERSATION_ID}/events?after=3&limit=25`,
      );
      expect(init).toMatchObject({
        method: "GET",
        credentials: "same-origin",
        mode: "same-origin",
      });
      return Response.json(replayEnvelope({ events, cursor: 5 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const replay = await readAdminConversationEvents(CONVERSATION_ID, {
      after: 3,
      limit: 25,
    });

    expect(replay.events).toEqual(events);
    expect(replay.cursor).toBe(5);
    expect(replay.hasMore).toBe(false);
  });

  it("cancels and deletes through body-only and bodyless same-origin requests", async () => {
    const event = cancellationEvent();
    const fetchMock = vi.fn()
      .mockImplementationOnce(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          `/api/assistant/conversations/${CONVERSATION_ID}/cancel`,
        );
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          clientRequestId: "cancel_request_1",
          runId: "run_1",
        });
        return Response.json(successEnvelope({
          replayed: false,
          event,
          expiresAt: 1_725_604_800_000,
        }), { status: 202 });
      })
      .mockImplementationOnce(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          `/api/assistant/conversations/${CONVERSATION_ID}`,
        );
        expect(init?.method).toBe("DELETE");
        expect(init?.body).toBeUndefined();
        return Response.json(successEnvelope({ deleted: true }));
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(cancelAdminConversationRun(CONVERSATION_ID, {
      clientRequestId: "cancel_request_1",
      runId: "run_1",
    })).resolves.toMatchObject({ event, replayed: false });
    await expect(deleteAdminConversation(CONVERSATION_ID)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces bounded server failures and rejects malformed success envelopes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        success: false,
        error: {
          code: "admin_conversation_unauthorized",
          message: "Dashboard session expired.",
        },
      }, { status: 401 }))
      .mockResolvedValueOnce(Response.json(replayEnvelope({
        events: [{
          ...messageEvent(),
          message: { ...messageEvent().message, contextMarker: "storefront:home" },
        }],
      })));
    vi.stubGlobal("fetch", fetchMock);

    const unauthorized = readAdminConversationEvents(CONVERSATION_ID);
    await expect(unauthorized).rejects.toMatchObject({
      name: "AdminConversationTransportError",
      code: "admin_conversation_unauthorized",
      status: 401,
      message: "Dashboard session expired.",
    });
    await expect(readAdminConversationEvents(CONVERSATION_ID)).rejects.toMatchObject({
      code: "conversation_response_invalid",
      status: 502,
    });
  });

  it("rejects weak IDs and invalid cursors before issuing a network request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(readAdminConversationEvents("conv_short")).rejects.toBeInstanceOf(
      AdminConversationTransportError,
    );
    await expect(readAdminConversationEvents(CONVERSATION_ID, { after: -1 }))
      .rejects.toMatchObject({ code: "conversation_cursor_invalid" });
    await expect(readAdminConversationEvents(CONVERSATION_ID, { limit: 101 }))
      .rejects.toMatchObject({ code: "conversation_limit_invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("polls through the safe event endpoint and stops cleanly when aborted", async () => {
    const controller = new AbortController();
    const event = messageEvent(7);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(replayEnvelope({ events: [event], cursor: 7 }))
    );
    vi.stubGlobal("fetch", fetchMock);
    const onEvents = vi.fn(() => controller.abort());

    const finalCursor = await pollAdminConversationEvents({
      conversationId: CONVERSATION_ID,
      after: 3,
      signal: controller.signal,
      onEvents,
    });

    expect(finalCursor).toBe(7);
    expect(onEvents).toHaveBeenCalledWith([event], expect.objectContaining({ cursor: 7 }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/events?after=3&limit=50");
  });
});
