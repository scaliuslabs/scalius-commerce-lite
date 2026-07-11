// @vitest-environment happy-dom

import type {
  FlueConversationMessage,
  FlueConversationPart,
} from "@flue/sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AdminAssistantConversation,
  projectAdminAssistantMessages,
} from "./AdminAssistantConversation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("Admin assistant conversation projection", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("collapses completed tool-only messages into one final assistant answer", () => {
    const privatePayload = `private-payload-${"x".repeat(2_000)}`;
    const messages = [
      message("user", "user", [text("Create a product")], "submission-1"),
      message(
        "tool-start",
        "assistant",
        [tool("scalius", "catalog", "input-available", privatePayload)],
        "submission-1",
      ),
      message(
        "tool-finished",
        "assistant",
        [tool("scalius", "catalog", "output-available", privatePayload)],
        "submission-1",
      ),
      message(
        "page-finished",
        "assistant",
        [tool("computer", "page", "output-available", privatePayload)],
        "submission-1",
      ),
      message(
        "answer",
        "assistant",
        [text("Product draft is ready.")],
        "submission-1",
      ),
    ];

    const projected = projectAdminAssistantMessages(messages);

    expect(projected).toHaveLength(2);
    expect(projected[1]).toMatchObject({
      id: "answer",
      role: "assistant",
      parts: [{ type: "text", text: "Product draft is ready." }],
    });
    expect(JSON.stringify(projected)).not.toContain(privatePayload);
  });

  it("retains only bounded active and failed tool state until final text exists", () => {
    const projected = projectAdminAssistantMessages([
      message("user", "user", [text("Check products")], "submission-2"),
      message(
        "completed",
        "assistant",
        [tool("scalius", "complete", "output-available")],
        "submission-2",
      ),
      message(
        "failed",
        "assistant",
        [tool("computer", "failed", "output-error")],
        "submission-2",
      ),
      message(
        "active-old",
        "assistant",
        [tool("computer", "active-old", "input-available")],
        "submission-2",
      ),
      message(
        "active-new",
        "assistant",
        [tool("scalius", "active-new", "input-available")],
        "submission-2",
      ),
    ]);

    expect(projected).toHaveLength(2);
    expect(projected[1]?.parts.map((part) =>
      part.type === "dynamic-tool" ? `${part.toolCallId}:${part.state}` : part.type
    )).toEqual([
      "failed:output-error",
      "active-old:input-available",
      "active-new:input-available",
    ]);
  });

  it("renders one assistant article without completed chips or raw tool payloads", () => {
    const privatePayload = `never-render-${"y".repeat(1_000)}`;
    const messages = [
      message("user", "user", [text("Count products")], "submission-3"),
      message(
        "tool",
        "assistant",
        [tool("scalius", "count", "output-available", privatePayload)],
        "submission-3",
      ),
      message(
        "answer",
        "assistant",
        [text("You have 24 products.")],
        "submission-3",
      ),
    ];

    act(() => {
      root.render(
        <AdminAssistantConversation
          threadId="conv_abcdefghijklmnopqrstuv"
          messages={messages}
          sending={false}
          onSuggestion={vi.fn()}
        />,
      );
    });

    expect(host.querySelectorAll('[data-assistant-message-role="assistant"]'))
      .toHaveLength(1);
    expect(host.querySelector("[data-assistant-tool]")).toBeNull();
    expect(host.textContent).toContain("You have 24 products.");
    expect(host.textContent).not.toContain(privatePayload);
  });

  it("omits the exact live machine continuation even across submission groups", () => {
    const machineContinuation = JSON.stringify(
      {
        authoritative: false,
        programDigest: "d".repeat(43),
        protocolVersion: 1,
        receivedAt: "2026-07-11T01:12:13.456Z",
        replayPolicy: "expiry_bound_non_authoritative",
        requestId: "r".repeat(22),
        result: {
          changed: true,
          code: "NAVIGATED",
          ok: true,
          output: "Navigated to /admin/products.",
        },
        surface: "admin",
        type: "UNTRUSTED_CLIENT_RESULT",
        warning:
          "Browser execution is untrusted and is not commerce authority.",
      },
      null,
      2,
    );
    const confirmationContinuation = JSON.stringify({
      authoritative: false,
      programDigest: "c".repeat(43),
      protocolVersion: 1,
      receivedAt: "2026-07-11T01:12:14.456Z",
      replayPolicy: "expiry_bound_non_authoritative",
      requestId: "q".repeat(22),
      result: {
        code: "CONFIRMATION_REQUIRED",
        ok: false,
        output: "Human confirmation is required before Save Product.",
        retryable: true,
      },
      surface: "admin",
      type: "UNTRUSTED_CLIENT_RESULT",
      warning:
        "Browser execution is untrusted and is not commerce authority.",
    });
    const messages = [
      message(
        "user-navigation",
        "user",
        [text("Take me to the Products page.")],
        "submission-user",
      ),
      message(
        "opening",
        "assistant",
        [text("Opening Products…")],
        "submission-command",
      ),
      message(
        "private-continuation",
        "assistant",
        [text(machineContinuation)],
        "submission-continuation",
      ),
      message(
        "private-confirmation-continuation",
        "assistant",
        [text(confirmationContinuation)],
        "submission-confirmation-continuation",
      ),
      message(
        "complete",
        "assistant",
        [text("Products opened.")],
        "submission-complete",
      ),
    ];

    const projected = projectAdminAssistantMessages(messages);

    expect(projected.map((entry) => entry.id)).toEqual([
      "user-navigation",
      "opening",
      "complete",
    ]);
    expect(JSON.stringify(projected)).not.toContain(
      "UNTRUSTED_CLIENT_RESULT",
    );

    act(() => {
      root.render(
        <AdminAssistantConversation
          threadId="conv_abcdefghijklmnopqrstuv"
          messages={messages}
          sending={false}
          onSuggestion={vi.fn()}
        />,
      );
    });
    expect(host.textContent).toContain("Products opened.");
    expect(host.textContent).not.toContain("programDigest");
    expect(host.textContent).not.toContain("Navigated to /admin/products.");
  });

  it("keeps user-authored and malformed lookalike JSON visible", () => {
    const userJson = JSON.stringify({
      authoritative: false,
      programDigest: "u".repeat(43),
      protocolVersion: 1,
      receivedAt: "2026-07-11T01:12:15.456Z",
      replayPolicy: "expiry_bound_non_authoritative",
      requestId: "v".repeat(22),
      result: {
        changed: false,
        code: "OBSERVED",
        ok: true,
        output: "Exact user-authored protocol JSON must stay visible.",
      },
      surface: "admin",
      type: "UNTRUSTED_CLIENT_RESULT",
      warning:
        "Browser execution is untrusted and is not commerce authority.",
    });
    const malformedAssistantJson = JSON.stringify({
      type: "UNTRUSTED_CLIENT_RESULT",
      authoritative: false,
      message: "This is ordinary user-facing JSON, not a protocol envelope.",
    });
    const projected = projectAdminAssistantMessages([
      message("user-json", "user", [text(userJson)], "submission-user-json"),
      message(
        "assistant-json",
        "assistant",
        [text(malformedAssistantJson)],
        "submission-assistant-json",
      ),
    ]);

    expect(projected).toHaveLength(2);
    expect(projected[0]?.parts).toContainEqual(text(userJson));
    expect(projected[1]?.parts).toContainEqual(text(malformedAssistantJson));
  });
});

function message(
  id: string,
  role: FlueConversationMessage["role"],
  parts: FlueConversationPart[],
  submissionId?: string,
): FlueConversationMessage {
  return { id, role, parts, submissionId };
}

function text(value: string): FlueConversationPart {
  return { type: "text", text: value, state: "done" };
}

function tool(
  toolName: string,
  toolCallId: string,
  state: "input-available" | "output-available" | "output-error",
  payload = "bounded",
): FlueConversationPart {
  if (state === "input-available") {
    return {
      type: "dynamic-tool",
      toolName,
      toolCallId,
      state,
      input: { payload },
    };
  }
  if (state === "output-available") {
    return {
      type: "dynamic-tool",
      toolName,
      toolCallId,
      state,
      input: { payload },
      output: { payload },
    };
  }
  return {
    type: "dynamic-tool",
    toolName,
    toolCallId,
    state,
    input: { payload },
    errorText: payload,
  };
}
