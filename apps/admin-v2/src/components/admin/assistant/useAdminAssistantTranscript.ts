import {
  createFlueClient,
  type AgentConversationObservation,
  type AgentConversationObservationSnapshot,
  type FlueClient,
  type FlueConversationMessage,
} from "@flue/sdk";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import {
  activateAdminAssistantConversationId,
  createNewAdminAssistantConversationId,
  getAdminAssistantConversationHistoryIds,
  getOrCreateAdminAssistantConversationId,
} from "./admin-assistant-transcript";

export const ADMIN_FLUE_AGENT_NAME = "admin-copilot";
export const ADMIN_FLUE_SAME_ORIGIN_BASE_URL = "/api/assistant/flue";

export type AdminAssistantTranscriptConnectionState =
  | { kind: "idle"; message: string }
  | { kind: "connecting"; message: string }
  | { kind: "connected"; message: string }
  | { kind: "disconnected"; message: string };

interface PendingUserMessage extends FlueConversationMessage {
  role: "user";
  local: true;
}

interface AdminFlueTransport {
  client: FlueClient;
  observation: AgentConversationObservation;
  subscribe: (listener: () => void) => () => void;
  threadId: string;
}

interface AdminAssistantSettlementNotice {
  kind: "failed" | "aborted";
  message: string;
}

interface AdminAssistantTranscriptController {
  threadId: string;
  conversationHistoryIds: string[];
  messages: FlueConversationMessage[];
  state: AdminAssistantTranscriptConnectionState;
  sending: boolean;
  aborting: boolean;
  canAbort: boolean;
  canStartNewConversation: boolean;
  operationError: string | null;
  settlementNotice: AdminAssistantSettlementNotice | null;
  sendMessage: (message: string) => Promise<boolean>;
  abort: () => Promise<boolean>;
  startNewConversation: () => string | null;
  switchConversation: (threadId: string) => boolean;
  retry: () => void;
  clearOperationError: () => void;
}

const EMPTY_OBSERVATION_SNAPSHOT: AgentConversationObservationSnapshot = {
  conversation: undefined,
  offset: undefined,
  phase: "closed",
  error: undefined,
};

const NOOP_UNSUBSCRIBE = () => {};
const NOOP_SUBSCRIBE = () => NOOP_UNSUBSCRIBE;
let optimisticSequence = 0;

export function useAdminAssistantTranscript(): AdminAssistantTranscriptController {
  const [threadId, setThreadId] = useState(
    getOrCreateAdminAssistantConversationId,
  );
  const [conversationHistoryIds, setConversationHistoryIds] = useState(
    getAdminAssistantConversationHistoryIds,
  );
  const transport = useMemo(() => createBrowserTransport(threadId), [threadId]);
  const [pendingMessages, setPendingMessages] = useState<PendingUserMessage[]>(
    [],
  );
  const [admitting, setAdmitting] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);

  const subscribe = useCallback(
    (listener: () => void) =>
      transport?.subscribe(listener) ?? NOOP_SUBSCRIBE(),
    [transport],
  );
  const getSnapshot = useCallback(
    () => transport?.observation.getSnapshot() ?? EMPTY_OBSERVATION_SNAPSHOT,
    [transport],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => EMPTY_OBSERVATION_SNAPSHOT,
  );

  const durableMessages = useMemo(
    () => snapshot.conversation?.messages ?? [],
    [snapshot.conversation?.messages],
  );
  const settledSubmissionIds = useMemo(
    () =>
      new Set(
        (snapshot.conversation?.settlements ?? []).map(
          (settlement) => settlement.submissionId,
        ),
      ),
    [snapshot.conversation?.settlements],
  );
  const activeSubmission = durableMessages.some(
    (message) =>
      message.submissionId !== undefined &&
      !settledSubmissionIds.has(message.submissionId),
  );

  useEffect(() => {
    const durableSubmissionIds = new Set(
      durableMessages.flatMap((message) =>
        message.submissionId ? [message.submissionId] : [],
      ),
    );
    if (durableSubmissionIds.size === 0) return;
    setPendingMessages((current) => {
      const next = current.filter(
        (message) =>
          !message.submissionId ||
          !durableSubmissionIds.has(message.submissionId),
      );
      return next.length === current.length ? current : next;
    });
  }, [durableMessages]);

  const messages = useMemo(
    () => mergePendingMessages(durableMessages, pendingMessages),
    [durableMessages, pendingMessages],
  );
  const admittedPendingMessage = pendingMessages.some(
    (message) => message.submissionId !== undefined,
  );
  const sending = admitting || admittedPendingMessage || activeSubmission;
  const settlementNotice = useMemo(
    () =>
      sending
        ? null
        : describeLatestSettlement(snapshot.conversation?.settlements ?? []),
    [sending, snapshot.conversation?.settlements],
  );

  const startNewConversation = useCallback((): string | null => {
    if (sending || aborting) return null;
    const nextThreadId = createNewAdminAssistantConversationId();
    setPendingMessages([]);
    setOperationError(null);
    setThreadId(nextThreadId);
    setConversationHistoryIds(getAdminAssistantConversationHistoryIds());
    return nextThreadId;
  }, [aborting, sending]);

  const switchConversation = useCallback(
    (nextThreadId: string): boolean => {
      if (
        sending ||
        aborting ||
        nextThreadId === threadId ||
        !activateAdminAssistantConversationId(nextThreadId)
      ) {
        return false;
      }
      setPendingMessages([]);
      setOperationError(null);
      setThreadId(nextThreadId);
      setConversationHistoryIds(getAdminAssistantConversationHistoryIds());
      return true;
    },
    [aborting, sending, threadId],
  );

  const sendMessage = useCallback(
    async (rawMessage: string): Promise<boolean> => {
      const message = rawMessage.trim();
      if (!transport || !message || message.length > 8_000 || sending) {
        return false;
      }

      const optimisticId = createOptimisticMessageId(transport.threadId);
      const optimisticMessage: PendingUserMessage = {
        id: optimisticId,
        role: "user",
        parts: [{ type: "text", text: message, state: "done" }],
        metadata: { timestamp: new Date().toISOString() },
        local: true,
      };
      setPendingMessages((current) => [...current, optimisticMessage]);
      setAdmitting(true);
      setOperationError(null);

      try {
        const admission = await transport.client.agents.send(
          ADMIN_FLUE_AGENT_NAME,
          transport.threadId,
          { message },
        );
        setPendingMessages((current) =>
          current.map((pending) =>
            pending.id === optimisticId
              ? { ...pending, submissionId: admission.submissionId }
              : pending,
          ),
        );
        if (
          snapshot.phase === "absent" ||
          snapshot.phase === "error" ||
          snapshot.phase === "closed"
        ) {
          transport.observation.refresh();
        }
        return true;
      } catch {
        setPendingMessages((current) =>
          current.filter((pending) => pending.id !== optimisticId),
        );
        setOperationError(
          "Assistant request failed before it was admitted. Nothing was changed.",
        );
        return false;
      } finally {
        setAdmitting(false);
      }
    },
    [sending, snapshot.phase, transport],
  );

  const abort = useCallback(async (): Promise<boolean> => {
    if (!transport || admitting || aborting) return false;
    setAborting(true);
    setOperationError(null);
    try {
      await transport.client.agents.abort(
        ADMIN_FLUE_AGENT_NAME,
        transport.threadId,
      );
      transport.observation.refresh();
      return true;
    } catch {
      setOperationError(
        "The stop request could not be confirmed. The assistant may still be working.",
      );
      return false;
    } finally {
      setAborting(false);
    }
  }, [aborting, admitting, transport]);

  const retry = useCallback(() => {
    setOperationError(null);
    transport?.observation.refresh();
  }, [transport]);

  return {
    threadId: transport?.threadId ?? "",
    conversationHistoryIds,
    messages,
    state: toConnectionState(snapshot, transport !== null),
    sending,
    aborting,
    canAbort:
      (admittedPendingMessage || activeSubmission) && !admitting && !aborting,
    canStartNewConversation: !sending && !aborting,
    operationError,
    settlementNotice,
    sendMessage,
    abort,
    startNewConversation,
    switchConversation,
    retry,
    clearOperationError: () => setOperationError(null),
  };
}

function createBrowserTransport(threadId: string): AdminFlueTransport | null {
  if (typeof window === "undefined") return null;
  const client = createFlueClient({ baseUrl: ADMIN_FLUE_SAME_ORIGIN_BASE_URL });
  const observation = client.agents.observe(ADMIN_FLUE_AGENT_NAME, threadId, {
    live: "long-poll",
  });
  return {
    client,
    threadId,
    observation,
    subscribe: createClosingSubscriber(observation),
  };
}

function createClosingSubscriber(
  observation: AgentConversationObservation,
): (listener: () => void) => () => void {
  let subscriberCount = 0;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  return (listener) => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = undefined;
    subscriberCount += 1;
    const unsubscribe = observation.subscribe(listener);
    return () => {
      unsubscribe();
      subscriberCount = Math.max(0, subscriberCount - 1);
      if (subscriberCount > 0) return;
      closeTimer = setTimeout(() => {
        if (subscriberCount === 0) observation.close();
      }, 0);
    };
  };
}

function mergePendingMessages(
  durable: readonly FlueConversationMessage[],
  pending: readonly PendingUserMessage[],
): FlueConversationMessage[] {
  if (pending.length === 0) return [...durable];
  const durableSubmissionIds = new Set(
    durable.flatMap((message) =>
      message.submissionId ? [message.submissionId] : [],
    ),
  );
  return [
    ...durable,
    ...pending
      .filter(
        (message) =>
          !message.submissionId ||
          !durableSubmissionIds.has(message.submissionId),
      )
      .map(({ local: _local, ...message }) => message),
  ];
}

function createOptimisticMessageId(threadId: string): string {
  optimisticSequence += 1;
  return `${threadId}:local:${Date.now().toString(36)}:${optimisticSequence.toString(36)}`;
}

function toConnectionState(
  snapshot: AgentConversationObservationSnapshot,
  transportReady: boolean,
): AdminAssistantTranscriptConnectionState {
  if (!transportReady) {
    return {
      kind: "idle",
      message: "Assistant connection starts after the dashboard loads.",
    };
  }
  if (snapshot.phase === "loading" || snapshot.phase === "connecting") {
    return {
      kind: "connecting",
      message: "Restoring this tab's durable assistant thread…",
    };
  }
  if (snapshot.phase === "live") {
    return { kind: "connected", message: "Assistant thread connected." };
  }
  if (snapshot.phase === "absent") {
    return { kind: "connected", message: "New assistant thread ready." };
  }
  return {
    kind: "disconnected",
    message:
      "Assistant thread is unavailable. Retry without reloading this page.",
  };
}

function describeLatestSettlement(
  settlements: NonNullable<
    AgentConversationObservationSnapshot["conversation"]
  >["settlements"],
): AdminAssistantSettlementNotice | null {
  const latest = settlements.at(-1);
  if (!latest || latest.outcome === "completed") return null;
  if (latest.outcome === "aborted") {
    return {
      kind: "aborted",
      message:
        "Assistant work stopped. Review any page changes already completed before continuing.",
    };
  }
  return {
    kind: "failed",
    message:
      "Assistant work failed before a confirmed completion. Review the page, then retry if needed.",
  };
}
