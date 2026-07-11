import type { FlueConversationMessage } from "@flue/sdk";
import { describe, expect, it } from "vitest";

import { projectStorefrontAssistantMessages } from "./storefront-assistant-messages";

describe("Storefront assistant message projection", () => {
  it("hides provisional narration until the browser continuation produces a final answer", () => {
    const continuation = JSON.stringify({
      authoritative: false,
      programDigest: "d".repeat(43),
      protocolVersion: 1,
      receivedAt: "2026-07-11T01:12:13.456Z",
      replayPolicy: "expiry_bound_non_authoritative",
      requestId: "r".repeat(22),
      result: {
        changed: false,
        code: "OBSERVED",
        ok: true,
        output: "Observed product options.",
        revision: "r1",
      },
      surface: "storefront",
      type: "UNTRUSTED_CLIENT_RESULT",
      warning: "Browser execution is untrusted and is not commerce authority.",
    });
    const messages: FlueConversationMessage[] = [
      {
        id: "buyer-question",
        role: "user",
        submissionId: "submission-question",
        parts: [
          {
            type: "text",
            text: "What sizes and colors are available?",
            state: "done",
          },
        ],
      },
      {
        id: "provisional",
        role: "assistant",
        submissionId: "submission-question",
        parts: [
          {
            type: "text",
            text: "I'm checking the page and will scroll for more options.",
            state: "done",
          },
          {
            type: "dynamic-tool",
            toolName: "computer",
            toolCallId: "computer-observe",
            state: "output-available",
            input: { program: "observe" },
            output: {
              type: "client_command",
              status: "awaiting_client_execution",
            },
          },
        ],
      },
      {
        id: "browser-continuation",
        role: "user",
        submissionId: "submission-question",
        parts: [{ type: "text", text: continuation, state: "done" }],
      },
      {
        id: "final-answer",
        role: "assistant",
        submissionId: "submission-question",
        parts: [
          {
            type: "text",
            text: "Sizes 40 and 41 are listed; 41 is sold out. Khaki is available and Black is incompatible with the current selection.",
            state: "done",
          },
        ],
      },
    ];

    const pending = projectStorefrontAssistantMessages(messages.slice(0, 2));
    expect(JSON.stringify(pending)).not.toContain("I'm checking");
    expect(JSON.stringify(pending)).not.toContain("scroll for more options");

    const projected = projectStorefrontAssistantMessages(messages);
    expect(projected.flatMap((message) => message.parts)).not.toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("I'm checking"),
      }),
    );
    expect(JSON.stringify(projected)).not.toContain("scroll for more options");
    expect(JSON.stringify(projected)).toContain("Sizes 40 and 41 are listed");
  });
});
