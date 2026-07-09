// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const conversationMocks = vi.hoisted(() => ({
  createConversationId: vi.fn(),
  isConversationId: vi.fn(),
}));

vi.mock("../../../lib/admin-assistant-conversation", () => ({
  createAdminConversationId: conversationMocks.createConversationId,
  isAdminConversationId: conversationMocks.isConversationId,
}));

import {
  ADMIN_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
  getAdminAssistantConversationContextMarker,
  getOrCreateAdminAssistantConversationId,
  mergeAdminAssistantConversationEvents,
  reconcileAdminAssistantPersistedMessage,
} from "./admin-assistant-transcript";
import type { AdminAssistantMessage } from "./assistant-panel-types";
import type { AdminAssistantPageStateSnapshot } from "./page-state";

const CONVERSATION_ID = "conv_abcdefghijklmnopqrstuv";

beforeEach(() => {
  window.sessionStorage.clear();
  conversationMocks.createConversationId.mockReset();
  conversationMocks.isConversationId.mockReset();
  conversationMocks.createConversationId.mockReturnValue(CONVERSATION_ID);
  conversationMocks.isConversationId.mockImplementation(
    (value: string) => value === CONVERSATION_ID,
  );
});

describe("admin assistant transcript helpers", () => {
  it("stores only a strong conversation ID in per-tab session storage", () => {
    expect(getOrCreateAdminAssistantConversationId()).toBe(CONVERSATION_ID);
    expect(getOrCreateAdminAssistantConversationId()).toBe(CONVERSATION_ID);

    expect(window.sessionStorage.length).toBe(1);
    expect(
      window.sessionStorage.getItem(
        ADMIN_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
      ),
    ).toBe(CONVERSATION_ID);
    expect(conversationMocks.createConversationId).toHaveBeenCalledTimes(1);
  });

  it("marks customer, order, auth, security, credential, payment, receipt, and recovery contexts sensitive", () => {
    for (const value of [
      "customers",
      "orders",
      "auth",
      "security",
      "credentials",
      "payments",
      "receipts",
      "recovery",
    ]) {
      expect(
        getAdminAssistantConversationContextMarker(
          pageState({ routePath: `/admin/settings/${value}` }),
        ),
      ).toBe("admin:sensitive");
    }

    expect(
      getAdminAssistantConversationContextMarker(
        pageState({ routePath: "/admin/products", pageTitle: "Products" }),
      ),
    ).toBe("admin:page");
    expect(
      getAdminAssistantConversationContextMarker(
        pageState({
          routePath: "/admin/settings",
          surfaces: [{ id: "payment-provider", kind: "form" }],
        }),
      ),
    ).toBe("admin:sensitive");
  });

  it("orders and deduplicates only user/assistant message events", () => {
    const merged = mergeAdminAssistantConversationEvents([], [
      messageEvent(2, "assistant", "Second"),
      cancellationEvent(3),
      messageEvent(1, "user", "First"),
      messageEvent(2, "assistant", "Second"),
    ]);

    expect(merged).toEqual([
      expect.objectContaining({
        id: "message_1",
        role: "user",
        content: "First",
        transcriptSequence: 1,
      }),
      expect.objectContaining({
        id: "message_2",
        role: "assistant",
        content: "Second",
        transcriptSequence: 2,
      }),
    ]);
  });

  it("reconciles a replay race while keeping live actions in memory only", () => {
    const optimistic: AdminAssistantMessage = {
      id: "message_client_1",
      role: "assistant",
      content: "Open products.",
      parts: [{ type: "text", text: "Open products." }],
      actions: [
        { type: "navigate", path: "/admin/products", label: "Open Products" },
      ],
    };
    const event = messageEvent(4, "assistant", "Open products.");
    const raced = mergeAdminAssistantConversationEvents(
      [optimistic],
      [event, event],
    );

    const reconciled = reconcileAdminAssistantPersistedMessage(
      raced,
      event,
      optimistic.id,
    );
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({
      id: "message_4",
      parts: optimistic.parts,
      actions: optimistic.actions,
      transcriptSequence: 4,
    });

    const rehydrated = mergeAdminAssistantConversationEvents([], [event]);
    expect(rehydrated[0]).not.toHaveProperty("parts");
    expect(rehydrated[0]).not.toHaveProperty("actions");
  });
});

function pageState(
  overrides: Partial<AdminAssistantPageStateSnapshot>,
): AdminAssistantPageStateSnapshot {
  return {
    version: 1,
    routePath: "/admin",
    pageTitle: null,
    pageHeading: null,
    mainScroll: {
      top: 0,
      maxTop: 0,
      viewportHeight: 600,
      contentHeight: 600,
      atTop: true,
      atBottom: true,
    },
    surfaces: [],
    ...overrides,
  };
}

function messageEvent(
  sequence: number,
  role: "user" | "assistant",
  content: string,
) {
  return {
    eventId: `event_${sequence}`,
    sequence,
    type: "message.appended" as const,
    occurredAt: 1_725_000_000_000 + sequence,
    message: {
      id: `message_${sequence}`,
      role,
      content,
      contextMarker: "admin:page" as const,
      createdAt: 1_725_000_000_000 + sequence,
    },
  };
}

function cancellationEvent(sequence: number) {
  return {
    eventId: `event_${sequence}`,
    sequence,
    type: "stream.cancelled" as const,
    occurredAt: 1_725_000_000_000 + sequence,
    cancellation: { runHash: "a".repeat(64) },
  };
}
