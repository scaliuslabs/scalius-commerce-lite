// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const THREAD_ID = "conv_abcdefghijklmnopqrstuv";

const sdkMocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  observe: vi.fn(),
  send: vi.fn(),
  abort: vi.fn(),
  refresh: vi.fn(),
  close: vi.fn(),
  listener: null as (() => void) | null,
  snapshot: {} as import("@flue/sdk").AgentConversationObservationSnapshot,
}));

const claimMocks = vi.hoisted(() => ({
  claim: vi.fn(async () => THREAD_ID),
  rotate: vi.fn(),
}));

vi.mock("@flue/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@flue/sdk")>()),
  createFlueClient: sdkMocks.createClient,
}));

vi.mock("./storefront-assistant-transcript", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./storefront-assistant-transcript")
  >()),
  claimStorefrontAssistantConversationId: claimMocks.claim,
  rotateStorefrontAssistantConversationClaim: claimMocks.rotate,
}));

import { FlueApiError } from "@flue/sdk";
import { useStorefrontFlueAgent } from "./useStorefrontFlueAgent";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("useStorefrontFlueAgent", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    sdkMocks.listener = null;
    sdkMocks.snapshot = {
      conversation: undefined,
      offset: undefined,
      phase: "absent",
      error: undefined,
    };
    sdkMocks.send.mockReset().mockResolvedValue({
      streamUrl: "https://store.test/stream",
      offset: "offset-1",
      submissionId: "submission_1",
    });
    sdkMocks.abort.mockReset().mockResolvedValue({ aborted: true });
    sdkMocks.refresh.mockReset();
    sdkMocks.close.mockReset();
    sdkMocks.observe.mockReset().mockReturnValue({
      getSnapshot: () => sdkMocks.snapshot,
      subscribe: (listener: () => void) => {
        sdkMocks.listener = listener;
        return () => {
          if (sdkMocks.listener === listener) sdkMocks.listener = null;
        };
      },
      refresh: sdkMocks.refresh,
      close: sdkMocks.close,
    });
    sdkMocks.createClient.mockReset().mockReturnValue({
      agents: {
        observe: sdkMocks.observe,
        send: sdkMocks.send,
        abort: sdkMocks.abort,
      },
    });
    claimMocks.claim.mockReset().mockResolvedValue(THREAD_ID);
    claimMocks.rotate.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("claims per-tab identity while collapsed without opening a network observation", async () => {
    await act(async () => {
      root.render(<Harness open={false} />);
      await Promise.resolve();
    });
    expect(claimMocks.claim).toHaveBeenCalledOnce();
    expect(sdkMocks.createClient).not.toHaveBeenCalled();
  });

  it("uses the cookie-scoped SDK base, optimistic user echo, and durable settlement", async () => {
    await act(async () => {
      root.render(<Harness open />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sdkMocks.createClient).toHaveBeenCalledWith({
      baseUrl: `/api/assistant/conversations/${THREAD_ID}/flue`,
    });
    expect(sdkMocks.observe).toHaveBeenCalledWith(
      "shopping-assistant",
      THREAD_ID,
      { live: "long-poll" },
    );

    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-send]")?.click();
      await Promise.resolve();
    });
    expect(sdkMocks.send).toHaveBeenCalledWith(
      "shopping-assistant",
      THREAD_ID,
      { message: "Show me shoes" },
    );
    expect(host.textContent).toContain("Show me shoes");
    expect(host.querySelector("[data-sending]")?.textContent).toBe("true");

    sdkMocks.snapshot = {
      phase: "live",
      offset: "offset-2",
      error: undefined,
      conversation: {
        conversationId: "default",
        messages: [
          {
            id: "user_durable",
            role: "user",
            submissionId: "submission_1",
            parts: [{ type: "text", text: "Show me shoes", state: "done" }],
          },
        ],
        settlements: [
          {
            submissionId: "submission_1",
            outcome: "completed",
          },
        ],
      },
    };
    await act(async () => sdkMocks.listener?.());
    expect(host.querySelector("[data-sending]")?.textContent).toBe("false");
    expect(host.textContent?.match(/Show me shoes/g)).toHaveLength(1);
  });

  it("rotates stale cookie authority only for fatal SDK authorization errors", async () => {
    sdkMocks.snapshot = {
      conversation: undefined,
      offset: undefined,
      phase: "error",
      error: new FlueApiError(401, { error: { message: "expired" } }),
    };
    await act(async () => {
      root.render(<Harness open />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-retry]")?.click();
      await Promise.resolve();
    });
    expect(claimMocks.rotate).toHaveBeenCalledOnce();
    expect(claimMocks.claim).toHaveBeenCalledTimes(2);
  });

  it("removes an optimistic bubble when prompt admission fails", async () => {
    sdkMocks.send.mockRejectedValueOnce(new Error("not admitted"));
    await act(async () => {
      root.render(<Harness open />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-send]")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain("Show me shoes");
    expect(host.querySelector("[data-sending]")?.textContent).toBe("false");
  });

  it("keeps a bounded opaque pointer when starting a new durable thread", async () => {
    window.sessionStorage.clear();
    await act(async () => {
      root.render(<Harness open />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-new]")?.click();
      await Promise.resolve();
    });
    expect(claimMocks.rotate).toHaveBeenCalledOnce();
    expect(host.querySelector("[data-previous]")?.textContent).toBe("true");
    expect(
      Array.from({ length: window.sessionStorage.length }, (_, index) =>
        window.sessionStorage.getItem(window.sessionStorage.key(index) ?? ""),
      ).join(" "),
    ).toContain(THREAD_ID);
  });
});

function Harness({ open }: { open: boolean }) {
  const agent = useStorefrontFlueAgent({ open });
  return (
    <div>
      <span data-sending="">{String(agent.sending)}</span>
      <span data-state="">{agent.state.kind}</span>
      {agent.messages.map((message) => (
        <span key={message.id}>
          {message.parts
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join(" ")}
        </span>
      ))}
      <button
        data-send=""
        onClick={() =>
          void agent.sendMessage("Show me shoes").catch(() => undefined)
        }
      >
        Send
      </button>
      <button data-retry="" onClick={agent.retry}>
        Retry
      </button>
      <button data-new="" onClick={agent.newConversation}>
        New
      </button>
      <span data-previous="">
        {String(agent.canResumePreviousConversation)}
      </span>
    </div>
  );
}
