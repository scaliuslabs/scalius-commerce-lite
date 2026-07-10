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
  switch: vi.fn(() => true),
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
  switchStorefrontAssistantConversationClaim: claimMocks.switch,
}));

import { FlueApiError } from "@flue/sdk";
import {
  useStorefrontFlueAgent,
  type StorefrontStoppedAdmissionReconciler,
} from "./useStorefrontFlueAgent";

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
    claimMocks.switch.mockReset().mockReturnValue(true);
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
      {
        message: "Show me shoes",
        signal: expect.any(AbortSignal),
      },
    );
    expect(host.textContent).toContain("Show me shoes");
    expect(host.querySelector("[data-sending]")?.textContent).toBe("true");
    expect(sdkMocks.refresh).toHaveBeenCalledOnce();

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

  it("does not send until the initial cookie authority history is resolved", async () => {
    sdkMocks.snapshot = {
      conversation: undefined,
      offset: undefined,
      phase: "loading",
      error: undefined,
    };
    await act(async () => {
      root.render(<Harness open />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-send]")?.click();
      await Promise.resolve();
    });
    expect(sdkMocks.send).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Show me shoes");
  });

  it("rehydrates an unsettled durable submission and serializes stop", async () => {
    let releaseAbort: ((value: { aborted: boolean }) => void) | undefined;
    sdkMocks.abort.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseAbort = resolve;
      }),
    );
    sdkMocks.snapshot = {
      phase: "live",
      offset: "offset-pending",
      error: undefined,
      conversation: {
        conversationId: "default",
        messages: [
          {
            id: "user_pending",
            role: "user",
            submissionId: "submission_pending",
            parts: [{ type: "text", text: "Keep working", state: "done" }],
          },
        ],
        settlements: [],
      },
    };
    await act(async () => {
      root.render(<Harness open />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelector("[data-sending]")?.textContent).toBe("true");
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-abort]")?.click();
      host.querySelector<HTMLButtonElement>("[data-abort]")?.click();
      await Promise.resolve();
    });
    expect(sdkMocks.abort).toHaveBeenCalledOnce();
    releaseAbort?.({ aborted: true });
    await act(async () => Promise.resolve());
    expect(host.querySelector("[data-sending]")?.textContent).toBe("true");
    expect(host.querySelector("[data-can-change]")?.textContent).toBe("false");

    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-new]")?.click();
      await Promise.resolve();
    });
    expect(claimMocks.rotate).not.toHaveBeenCalled();
  });

  it("keeps a never-settling admission blocked until the durable Stop barrier settles", async () => {
    sdkMocks.send.mockReturnValueOnce(
      new Promise(() => undefined),
    );
    const reconcile = vi.fn(async () => ({ status: "settled" as const }));
    await act(async () => {
      root.render(<Harness open reconciler={reconcile} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-send]")?.click();
      await Promise.resolve();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-abort]")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const sendSignal = sdkMocks.send.mock.calls[0]?.[2]?.signal;
    expect(sendSignal).toBeInstanceOf(AbortSignal);
    expect(sendSignal?.aborted).toBe(true);
    expect(sdkMocks.abort).toHaveBeenCalledOnce();
    expect(sdkMocks.abort).toHaveBeenNthCalledWith(
      1,
      "shopping-assistant",
      THREAD_ID,
      { signal: expect.any(AbortSignal) },
    );
    expect(reconcile).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      admissionStartedAt: expect.any(Number),
      signal: expect.any(AbortSignal),
    });
    expect(host.querySelector("[data-sending]")?.textContent).toBe("false");
    expect(host.querySelector("[data-can-change]")?.textContent).toBe("true");
  });

  it("does not reopen send when client cancellation races a later server admission response", async () => {
    let releaseSend:
      | ((value: {
          streamUrl: string;
          offset: string;
          submissionId: string;
        }) => void)
      | undefined;
    sdkMocks.send.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseSend = resolve;
      }),
    );
    let settleBarrier:
      | ((value: { status: "settled" | "pending" }) => void)
      | undefined;
    const reconcile = vi.fn(
      () =>
        new Promise<{ status: "settled" | "pending" }>((resolve) => {
          settleBarrier = resolve;
        }),
    );
    await act(async () => {
      root.render(<Harness open reconciler={reconcile} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-send]")?.click();
      await Promise.resolve();
      host.querySelector<HTMLButtonElement>("[data-abort]")?.click();
      await Promise.resolve();
    });
    expect(host.querySelector("[data-sending]")?.textContent).toBe("true");
    expect(host.querySelector("[data-can-change]")?.textContent).toBe("false");

    releaseSend?.({
      streamUrl: "https://store.test/stream-late",
      offset: "offset-late",
      submissionId: "submission_late",
    });
    await act(async () => Promise.resolve());
    expect(host.querySelector("[data-sending]")?.textContent).toBe("true");
    expect(claimMocks.rotate).not.toHaveBeenCalled();

    settleBarrier?.({ status: "settled" });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelector("[data-sending]")?.textContent).toBe("false");
    expect(host.querySelector("[data-can-change]")?.textContent).toBe("true");
  });

  it("trusts the same-origin abort facade as the durable Stop authority", async () => {
    sdkMocks.send.mockReturnValueOnce(new Promise(() => undefined));
    await act(async () => {
      root.render(<Harness open />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-send]")?.click();
      await Promise.resolve();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-abort]")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sdkMocks.abort).toHaveBeenCalledOnce();
    expect(host.querySelector("[data-sending]")?.textContent).toBe("false");
    expect(host.querySelector("[data-can-change]")?.textContent).toBe("true");
  });

  it("releases a stale pending projection when durable abort reports idle", async () => {
    sdkMocks.abort.mockResolvedValueOnce({ aborted: false });
    sdkMocks.snapshot = {
      phase: "live",
      offset: "offset-stale",
      error: undefined,
      conversation: {
        conversationId: "default",
        messages: [
          {
            id: "user_stale",
            role: "user",
            submissionId: "submission_stale",
            parts: [{ type: "text", text: "Old request", state: "done" }],
          },
        ],
        settlements: [],
      },
    };
    await act(async () => {
      root.render(<Harness open />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelector("[data-sending]")?.textContent).toBe("true");
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-abort]")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelector("[data-sending]")?.textContent).toBe("false");
    expect(host.querySelector("[data-can-change]")?.textContent).toBe("true");

    await act(async () => sdkMocks.listener?.());
    expect(host.querySelector("[data-sending]")?.textContent).toBe("false");
  });

  it("clears sending only after the durable settlement when work was aborted", async () => {
    sdkMocks.snapshot = {
      phase: "live",
      offset: "offset-pending",
      error: undefined,
      conversation: {
        conversationId: "default",
        messages: [
          {
            id: "user_pending",
            role: "user",
            submissionId: "submission_pending",
            parts: [{ type: "text", text: "Keep working", state: "done" }],
          },
        ],
        settlements: [],
      },
    };
    await act(async () => {
      root.render(<Harness open />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-abort]")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    sdkMocks.snapshot = {
      ...sdkMocks.snapshot,
      conversation: {
        ...sdkMocks.snapshot.conversation!,
        settlements: [
          { submissionId: "submission_pending", outcome: "aborted" },
        ],
      },
    };
    await act(async () => sdkMocks.listener?.());
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

  it("can resume any retained opaque thread instead of toggling only two", async () => {
    const retained = [
      "conv_bcdefghijklmnopqrstuvw",
      "conv_cdefghijklmnopqrstuvwx",
      "conv_defghijklmnopqrstuvwxy",
    ];
    window.sessionStorage.setItem(
      "scalius.storefront-assistant.recent-flue-threads.v1",
      JSON.stringify(retained),
    );
    await act(async () => {
      root.render(<Harness open />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelector("[data-recent]")?.textContent).toContain(
      "3 threads back",
    );
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>(`[data-resume="${retained[2]}"]`)
        ?.click();
      await Promise.resolve();
    });
    expect(claimMocks.switch).toHaveBeenCalledWith(retained[2]);
  });
});

function Harness({
  open,
  reconciler,
}: {
  open: boolean;
  reconciler?: StorefrontStoppedAdmissionReconciler;
}) {
  const agent = useStorefrontFlueAgent({
    open,
    reconcileStoppedAdmission: reconciler,
  });
  return (
    <div>
      <span data-sending="">{String(agent.sending)}</span>
      <span data-state="">{agent.state.kind}</span>
      <span data-aborting="">{String(agent.aborting)}</span>
      <span data-can-change="">{String(agent.canChangeConversation)}</span>
      <span data-recent="">
        {agent.recentThreads.map((thread) => thread.label).join("|")}
      </span>
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
      <button
        data-abort=""
        onClick={() => void agent.abort().catch(() => undefined)}
      >
        Stop
      </button>
      {agent.recentThreads.map((thread) => (
        <button
          key={thread.threadId}
          data-resume={thread.threadId}
          onClick={() => agent.resumeConversation(thread.threadId)}
        >
          {thread.label}
        </button>
      ))}
      <span data-previous="">
        {String(agent.canResumePreviousConversation)}
      </span>
    </div>
  );
}
