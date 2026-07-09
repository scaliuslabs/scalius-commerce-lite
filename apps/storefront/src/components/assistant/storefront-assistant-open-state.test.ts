// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  STOREFRONT_ASSISTANT_OPEN_STATE_STORAGE_KEY,
  readStorefrontAssistantOpenState,
  writeStorefrontAssistantOpenState,
} from "./storefront-assistant-open-state";
import {
  STOREFRONT_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
  getOrCreateStorefrontAssistantConversationId,
} from "./storefront-assistant-transcript";
import { installMemoryBrowserStorage } from "./assistant-test-storage";

describe("storefront assistant open state", () => {
  beforeEach(() => {
    installMemoryBrowserStorage();
    window.sessionStorage.clear();
  });

  it("stores only a session-scoped open marker and removes it on close", () => {
    expect(readStorefrontAssistantOpenState()).toBe(false);
    expect(writeStorefrontAssistantOpenState(true)).toBe(true);
    expect(readStorefrontAssistantOpenState()).toBe(true);
    expect(
      window.sessionStorage.getItem(
        STOREFRONT_ASSISTANT_OPEN_STATE_STORAGE_KEY,
      ),
    ).toBe("open");
    expect(JSON.stringify(window.sessionStorage)).not.toMatch(
      /message|context|customer|email|phone|token|credential/i,
    );

    expect(writeStorefrontAssistantOpenState(false)).toBe(true);
    expect(readStorefrontAssistantOpenState()).toBe(false);
    expect(
      window.sessionStorage.getItem(
        STOREFRONT_ASSISTANT_OPEN_STATE_STORAGE_KEY,
      ),
    ).toBeNull();
  });

  it("keeps the existing per-tab conversation when the panel reopens", () => {
    const conversationId = getOrCreateStorefrontAssistantConversationId();
    expect(writeStorefrontAssistantOpenState(true)).toBe(true);

    expect(getOrCreateStorefrontAssistantConversationId()).toBe(conversationId);
    expect(window.sessionStorage.length).toBe(2);
    expect(
      window.sessionStorage.getItem(
        STOREFRONT_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
      ),
    ).toBe(conversationId);
    expect(
      window.sessionStorage.getItem(
        STOREFRONT_ASSISTANT_OPEN_STATE_STORAGE_KEY,
      ),
    ).toBe("open");
  });

  it("fails closed when session storage is unavailable", () => {
    const denied = {
      getItem: vi.fn(() => {
        throw new DOMException("denied");
      }),
      setItem: vi.fn(() => {
        throw new DOMException("denied");
      }),
      removeItem: vi.fn(() => {
        throw new DOMException("denied");
      }),
    };

    expect(readStorefrontAssistantOpenState(denied)).toBe(false);
    expect(writeStorefrontAssistantOpenState(true, denied)).toBe(false);
    expect(writeStorefrontAssistantOpenState(false, denied)).toBe(false);
  });
});
