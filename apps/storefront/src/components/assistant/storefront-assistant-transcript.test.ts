// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildStorefrontAssistantPageContext } from
  "@/lib/assistant-page-context";
import type { StorefrontAssistantUiMessage } from
  "./storefront-assistant-chat";
import type { StorefrontConversationMessageEvent } from
  "./storefront-assistant-conversation";
import {
  STOREFRONT_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
  claimStorefrontAssistantConversationId,
  getOrCreateStorefrontAssistantConversationId,
  mergeStorefrontConversationEvents,
  reconcileStorefrontPersistedMessage,
  rotateStorefrontAssistantConversationClaim,
  storefrontConversationContextMarker,
} from "./storefront-assistant-transcript";
import { installMemoryBrowserStorage } from "./assistant-test-storage";

function event(
  sequence: number,
  role: "user" | "assistant",
  content: string,
): StorefrontConversationMessageEvent {
  return {
    eventId: `event_${sequence}`,
    sequence,
    type: "message.appended",
    occurredAt: sequence,
    message: {
      id: `durable_${sequence}`,
      role,
      content,
      contextMarker: "storefront:product",
      createdAt: sequence,
    },
  };
}

describe("Storefront transcript integration", () => {
  beforeEach(() => {
    installMemoryBrowserStorage();
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it("keeps only an opaque conversation id in per-tab sessionStorage", () => {
    const first = getOrCreateStorefrontAssistantConversationId();
    const second = getOrCreateStorefrontAssistantConversationId();

    expect(first).toBe(second);
    expect(first).toMatch(/^conv_[A-Za-z0-9_-]{22}$/);
    expect(window.sessionStorage.length).toBe(1);
    expect(window.sessionStorage.getItem(
      STOREFRONT_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
    )).toBe(first);
    expect(window.localStorage.length).toBe(0);
    expect(JSON.stringify([...Array(window.sessionStorage.length).keys()].map(
      (index) => window.sessionStorage.key(index),
    ))).not.toMatch(/subject|credential|session_asst/i);
  });

  it("marks account, checkout, order, payment, receipt, and recovery pages sensitive", () => {
    for (const path of [
      "/account",
      "/checkout",
      "/order-success",
      "/payment-recovery",
      "/receipt",
      "/auth/login",
    ]) {
      expect(storefrontConversationContextMarker(
        buildStorefrontAssistantPageContext({ path, route: path }),
      )).toBe("storefront:sensitive");
    }
    expect(storefrontConversationContextMarker(
      buildStorefrontAssistantPageContext({
        path: "/products/rice",
        route: "/products/[slug]",
        pageKind: "product",
      }),
    )).toBe("storefront:product");
  });

  it("hydrates in sequence, dedupes replay, and keeps rich parts live-only", () => {
    const hydrated = mergeStorefrontConversationEvents([], [
      event(2, "assistant", "Second"),
      event(1, "user", "First"),
      event(2, "assistant", "Second"),
    ]);
    expect(hydrated.map((message) => message.id)).toEqual([
      "durable_1",
      "durable_2",
    ]);
    expect(hydrated.map((message) => message.transcriptSequence)).toEqual([
      1,
      2,
    ]);

    const live: StorefrontAssistantUiMessage = {
      id: "live_message",
      role: "assistant",
      parts: [
        { type: "text", text: "Second" },
        {
          type: "navigation",
          path: "/products/rice",
          label: "Open rice",
          requiresConfirmation: true,
        },
      ],
    };
    const reconciled = reconcileStorefrontPersistedMessage(
      [live],
      event(2, "assistant", "Second"),
      live.id,
    );
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({
      id: "durable_2",
      transcriptSequence: 2,
    });
    expect(reconciled[0]?.parts.map((part) => part.type)).toEqual([
      "text",
      "navigation",
    ]);

    const afterReload = mergeStorefrontConversationEvents([], [
      event(2, "assistant", "Second"),
    ]);
    expect(afterReload[0]?.parts).toEqual([{ type: "text", text: "Second" }]);
  });

  it("recovers from denied sessionStorage without persisting authority", () => {
    const getItem = vi.spyOn(window.sessionStorage, "getItem").mockImplementation(
      () => {
        throw new DOMException("denied");
      },
    );
    const first = getOrCreateStorefrontAssistantConversationId();
    const second = getOrCreateStorefrontAssistantConversationId();
    getItem.mockRestore();

    expect(first).toMatch(/^conv_[A-Za-z0-9_-]{22}$/);
    expect(second).toMatch(/^conv_[A-Za-z0-9_-]{22}$/);
    expect(
      window.sessionStorage.getItem(
        STOREFRONT_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
      ),
    ).toBeNull();
    expect(first).not.toMatch(/subject|credential|session_asst/i);
    expect(second).not.toMatch(/subject|credential|session_asst/i);
  });

  it("rotates a copied ID when an original collapsed tab holds its Web Lock", async () => {
    const copiedId = "conv_abcdefghijklmnopqrstuv";
    window.sessionStorage.setItem(
      STOREFRONT_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
      copiedId,
    );
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    const request = vi.fn((
      name: string,
      _options: LockOptions,
      callback: (lock: Lock | null) => Promise<void> | void,
    ) => {
      const lock = name.endsWith(copiedId)
        ? null
        : ({ name, mode: "exclusive" } as Lock);
      void callback(lock);
      return Promise.resolve();
    });
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request } as unknown as LockManager,
    });

    try {
      const claimed = await claimStorefrontAssistantConversationId();
      expect(claimed).not.toBe(copiedId);
      expect(claimed).toMatch(/^conv_[A-Za-z0-9_-]{22}$/);
      expect(request).toHaveBeenCalledTimes(2);
      expect(String(request.mock.calls[0]?.[0])).toContain(copiedId);
      expect(String(request.mock.calls[1]?.[0])).toContain(claimed);
      expect(window.localStorage.length).toBe(0);
    } finally {
      rotateStorefrontAssistantConversationClaim();
      if (originalLocks) {
        Object.defineProperty(navigator, "locks", originalLocks);
      } else {
        Object.defineProperty(navigator, "locks", {
          configurable: true,
          value: undefined,
        });
      }
    }
  });
});
