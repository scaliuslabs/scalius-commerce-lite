// @vitest-environment happy-dom

import type { FlueConversationPart } from "@flue/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { StorefrontFlueMessageParts } from "./StorefrontFlueMessageParts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("StorefrontFlueMessageParts", () => {
  it("renders one compact answer, at most three tool rows, and no raw tool payload", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const parts: FlueConversationPart[] = [
      { type: "text", text: "A".repeat(900), state: "done" },
      ...Array.from(
        { length: 5 },
        (_, index): FlueConversationPart => ({
          type: "dynamic-tool",
          toolName: index % 2 === 0 ? "scalius" : "computer",
          toolCallId: `tool_${index}`,
          state: "output-available",
          input: { program: "hidden input" },
          output: { privatePayload: `MUST_NOT_RENDER_${index}` },
        }),
      ),
    ];

    act(() => root.render(<StorefrontFlueMessageParts parts={parts} />));

    expect(host.querySelectorAll("[data-assistant-short-answer]")).toHaveLength(
      1,
    );
    expect(
      host.querySelectorAll("[data-assistant-tool-step]").length,
    ).toBeLessThanOrEqual(3);
    expect(host.textContent).toContain("2 earlier steps condensed");
    expect(host.textContent).not.toContain("MUST_NOT_RENDER");
    expect(host.querySelector("table")).toBeNull();
    expect(host.querySelector("[data-assistant-disclosure]")).toBeTruthy();
    act(() => root.unmount());
  });

  it("allows one same-origin image and rejects off-origin attachment URLs", () => {
    window.history.replaceState(null, "", "/products/rice");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <StorefrontFlueMessageParts
          parts={[
            {
              type: "file",
              mediaType: "image/png",
              filename: "shoe.png",
              url: `${window.location.origin}/api/assistant/image/1`,
              state: "done",
            } as FlueConversationPart,
            {
              type: "file",
              mediaType: "image/png",
              filename: "off-origin.png",
              url: "https://evil.test/image.png",
              state: "done",
            } as FlueConversationPart,
          ]}
        />,
      ),
    );
    const images = host.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]?.src).toContain("/api/assistant/image/1");
    expect(host.textContent).not.toContain("off-origin.png");
    act(() => root.unmount());
  });
});
