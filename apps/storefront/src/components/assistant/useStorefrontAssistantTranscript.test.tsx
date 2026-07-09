// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimConversationId: vi.fn(() =>
    Promise.resolve("conv_abcdefghijklmnopqrstuv")
  ),
  rotateConversationId: vi.fn(),
  readEvents: vi.fn(),
}));

vi.mock("./storefront-assistant-transcript", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./storefront-assistant-transcript")
  >()),
  claimStorefrontAssistantConversationId: mocks.claimConversationId,
  rotateStorefrontAssistantConversationClaim: mocks.rotateConversationId,
}));

vi.mock("./storefront-assistant-conversation", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./storefront-assistant-conversation")
  >()),
  readStorefrontConversationEvents: mocks.readEvents,
}));

import { useStorefrontAssistantTranscript } from
  "./useStorefrontAssistantTranscript";
import { StorefrontConversationTransportError } from
  "./storefront-assistant-conversation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("useStorefrontAssistantTranscript", () => {
  it("claims tab ownership while the assistant panel is still collapsed", async () => {
    mocks.claimConversationId.mockClear();
    mocks.rotateConversationId.mockClear();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    function CollapsedAssistant() {
      useStorefrontAssistantTranscript({ open: false, onEvents: () => {} });
      return null;
    }

    await act(async () => {
      root.render(<CollapsedAssistant />);
      await Promise.resolve();
    });

    expect(mocks.claimConversationId).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("rotates a stale authority before offering transcript retry", async () => {
    mocks.claimConversationId.mockClear();
    mocks.rotateConversationId.mockClear();
    mocks.readEvents.mockReset();
    mocks.readEvents.mockRejectedValueOnce(
      new StorefrontConversationTransportError(
        "CONVERSATION_SESSION_EXPIRED",
        "Expired",
        401,
      ),
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    function OpenAssistant() {
      const transcript = useStorefrontAssistantTranscript({
        open: true,
        onEvents: () => {},
      });
      return <span data-state={transcript.state.kind}>{transcript.state.message}</span>;
    }

    await act(async () => {
      root.render(<OpenAssistant />);
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    });

    expect(mocks.rotateConversationId).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Retry to start a fresh");
    expect(host.querySelector('[data-state="disconnected"]')).toBeTruthy();
    act(() => root.unmount());
  });
});
