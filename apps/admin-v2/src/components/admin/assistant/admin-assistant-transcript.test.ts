// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
  ADMIN_ASSISTANT_CONVERSATION_HISTORY_STORAGE_KEY,
  createNewAdminAssistantConversationId,
  activateAdminAssistantConversationId,
  getAdminAssistantConversationHistoryIds,
  getOrCreateAdminAssistantConversationId,
  getOrCreateAdminAssistantTabId,
} from "./admin-assistant-transcript";

describe("Admin Flue browser identities", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("keeps one valid durable thread ID in this browser tab", () => {
    const first = getOrCreateAdminAssistantConversationId();
    const second = getOrCreateAdminAssistantConversationId();

    expect(first).toMatch(/^conv_[A-Za-z0-9_-]{22}$/u);
    expect(second).toBe(first);
    expect(
      window.sessionStorage.getItem(
        ADMIN_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
      ),
    ).toBe(first);
  });

  it("replaces malformed persisted thread IDs instead of forwarding them", () => {
    window.sessionStorage.setItem(
      ADMIN_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
      "conv_invalid/path",
    );

    const replacement = getOrCreateAdminAssistantConversationId();
    expect(replacement).toMatch(/^conv_[A-Za-z0-9_-]{22}$/u);
    expect(replacement).not.toBe("conv_invalid/path");
  });

  it("uses a process-local tab binding distinct from the durable thread", () => {
    const threadId = getOrCreateAdminAssistantConversationId();
    const firstTabId = getOrCreateAdminAssistantTabId();
    const secondTabId = getOrCreateAdminAssistantTabId();

    expect(firstTabId).toMatch(/^tab_[A-Za-z0-9_-]{22}$/u);
    expect(secondTabId).toBe(firstTabId);
    expect(firstTabId).not.toBe(threadId);
    expect(getAdminAssistantConversationHistoryIds()).toContain(threadId);
    expect(getAdminAssistantConversationHistoryIds()).not.toContain(
      firstTabId,
    );
  });

  it("rotates the active thread while retaining prior durable thread IDs", () => {
    const first = getOrCreateAdminAssistantConversationId();
    const second = createNewAdminAssistantConversationId();

    expect(second).toMatch(/^conv_[A-Za-z0-9_-]{22}$/u);
    expect(second).not.toBe(first);
    expect(
      window.sessionStorage.getItem(
        ADMIN_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
      ),
    ).toBe(second);
    expect(getAdminAssistantConversationHistoryIds()).toEqual([first, second]);
    expect(
      window.sessionStorage.getItem(
        ADMIN_ASSISTANT_CONVERSATION_HISTORY_STORAGE_KEY,
      ),
    ).not.toContain("message");

    expect(activateAdminAssistantConversationId(first)).toBe(true);
    expect(
      window.sessionStorage.getItem(
        ADMIN_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
      ),
    ).toBe(first);
    expect(getAdminAssistantConversationHistoryIds()).toEqual([second, first]);
    expect(activateAdminAssistantConversationId("conv_invalid/path")).toBe(
      false,
    );
  });
});
