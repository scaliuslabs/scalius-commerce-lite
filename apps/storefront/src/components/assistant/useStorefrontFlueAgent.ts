import {
  FlueApiError,
  createFlueClient,
  type AgentConversationObservation,
  type AgentConversationObservationSnapshot,
  type FlueClient,
  type FlueConversationMessage,
} from "@flue/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createStorefrontConversationRequestId } from "./storefront-assistant-conversation";
import {
  claimStorefrontAssistantConversationId,
  rotateStorefrontAssistantConversationClaim,
  switchStorefrontAssistantConversationClaim,
} from "./storefront-assistant-transcript";

const AGENT_NAME = "shopping-assistant";
const RECENT_THREADS_STORAGE_KEY =
  "scalius.storefront-assistant.recent-flue-threads.v1";
const MAX_RECENT_THREADS = 5;
const THREAD_ID_PATTERN = /^conv_[A-Za-z0-9_-]{22,64}$/u;

export type StorefrontFlueAgentState =
  | { kind: "idle"; message: string }
  | { kind: "connecting"; message: string }
  | { kind: "connected"; message: string }
  | { kind: "disconnected"; message: string };

interface ActiveObservation {
  client: FlueClient;
  observation: AgentConversationObservation;
  threadId: string;
}

interface OptimisticMessage extends FlueConversationMessage {
  submissionId?: string;
}

export interface StorefrontRecentThread {
  threadId: string;
  label: string;
}

const INITIAL_SNAPSHOT: AgentConversationObservationSnapshot = {
  conversation: undefined,
  offset: undefined,
  phase: "closed",
  error: undefined,
};

const INITIAL_STATE: StorefrontFlueAgentState = {
  kind: "idle",
  message: "Private shopping thread is idle.",
};

function browserSessionStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readRecentThreads(): string[] {
  const storage = browserSessionStorage();
  if (!storage) return [];
  try {
    const value = JSON.parse(
      storage.getItem(RECENT_THREADS_STORAGE_KEY) ?? "[]",
    ) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (entry): entry is string =>
          typeof entry === "string" && THREAD_ID_PATTERN.test(entry),
      )
      .slice(0, MAX_RECENT_THREADS);
  } catch {
    return [];
  }
}

function persistRecentThreads(threadIds: readonly string[]): string[] {
  const bounded = [...new Set(threadIds)]
    .filter((entry) => THREAD_ID_PATTERN.test(entry))
    .slice(0, MAX_RECENT_THREADS);
  try {
    browserSessionStorage()?.setItem(
      RECENT_THREADS_STORAGE_KEY,
      JSON.stringify(bounded),
    );
  } catch {
    // A new thread still works when privacy mode denies recent-thread pointers.
  }
  return bounded;
}

export function storefrontFlueBaseUrl(threadId: string): string {
  return `/api/assistant/conversations/${threadId}/flue`;
}

export function useStorefrontFlueAgent({ open }: { open: boolean }) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [snapshot, setSnapshot] =
    useState<AgentConversationObservationSnapshot>(INITIAL_SNAPSHOT);
  const [optimisticMessages, setOptimisticMessages] = useState<
    OptimisticMessage[]
  >([]);
  const [pendingSubmissionId, setPendingSubmissionId] = useState<string | null>(
    null,
  );
  const [admitting, setAdmitting] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [reconnectToken, setReconnectToken] = useState(0);
  const [recentThreadIds, setRecentThreadIds] =
    useState<string[]>(readRecentThreads);
  const activeRef = useRef<ActiveObservation | null>(null);
  const pendingSubmissionRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const abortPromiseRef = useRef<Promise<boolean> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    void claimStorefrontAssistantConversationId()
      .then((claimed) => {
        if (mountedRef.current) setThreadId(claimed);
      })
      .catch(() => undefined);
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reconcilePending = useCallback(
    (nextSnapshot: AgentConversationObservationSnapshot) => {
      const conversation = nextSnapshot.conversation;
      if (!conversation) return;
      const settledIds = new Set(
        conversation.settlements.map((settlement) => settlement.submissionId),
      );
      const durablePending = conversation.messages.findLast(
        (message) =>
          typeof message.submissionId === "string" &&
          !settledIds.has(message.submissionId),
      )?.submissionId;
      if (durablePending) {
        pendingSubmissionRef.current = durablePending;
        busyRef.current = true;
        setPendingSubmissionId(durablePending);
        setAdmitting(false);
        return;
      }

      const pendingId = pendingSubmissionRef.current;
      if (!pendingId || !settledIds.has(pendingId)) return;
      pendingSubmissionRef.current = null;
      busyRef.current = false;
      setPendingSubmissionId(null);
      setAdmitting(false);
    },
    [],
  );

  useEffect(() => {
    if (!open || !threadId) return undefined;

    const client = createFlueClient({
      baseUrl: storefrontFlueBaseUrl(threadId),
    });
    const observation = client.agents.observe(AGENT_NAME, threadId, {
      live: "long-poll",
    });
    const active = { client, observation, threadId };
    activeRef.current = active;

    const publish = () => {
      const next = observation.getSnapshot();
      setSnapshot(next);
      reconcilePending(next);
    };
    const unsubscribe = observation.subscribe(publish);
    publish();

    return () => {
      unsubscribe();
      observation.close();
      if (activeRef.current === active) activeRef.current = null;
    };
  }, [open, reconnectToken, reconcilePending, threadId]);

  const historyReady =
    snapshot.conversation !== undefined || snapshot.phase === "absent";
  const sending = admitting || pendingSubmissionId !== null;

  const messages = useMemo(() => {
    const canonical = snapshot.conversation?.messages ?? [];
    const durableSubmissionIds = new Set(
      canonical.flatMap((message) =>
        message.submissionId ? [message.submissionId] : [],
      ),
    );
    const durableIds = new Set(canonical.map((message) => message.id));
    const pending = optimisticMessages.filter(
      (message) =>
        !durableIds.has(message.id) &&
        (!message.submissionId ||
          !durableSubmissionIds.has(message.submissionId)),
    );
    return [...canonical, ...pending];
  }, [optimisticMessages, snapshot.conversation?.messages]);

  const state = useMemo<StorefrontFlueAgentState>(() => {
    if (!open) return INITIAL_STATE;
    if (snapshot.phase === "error") {
      return {
        kind: "disconnected",
        message:
          "Shopping help is disconnected. Retry before sending another request.",
      };
    }
    if (sending) {
      return {
        kind: "connected",
        message: "Working through the catalog and this page…",
      };
    }
    if (
      !threadId ||
      snapshot.phase === "loading" ||
      snapshot.phase === "connecting"
    ) {
      return {
        kind: "connecting",
        message: "Restoring this tab’s private shopping thread…",
      };
    }
    if (snapshot.phase === "absent") {
      return {
        kind: "connected",
        message: "A new private shopping thread is ready.",
      };
    }
    return {
      kind: "connected",
      message: "Private shopping thread connected.",
    };
  }, [open, sending, snapshot.phase, threadId]);

  const sendMessage = useCallback(
    async (message: string) => {
      const active = activeRef.current;
      if (
        !active ||
        active.threadId !== threadId ||
        !historyReady ||
        busyRef.current
      ) {
        throw new Error("Shopping assistant connection is not ready");
      }

      busyRef.current = true;
      const optimisticId = createStorefrontConversationRequestId("message");
      setOptimisticMessages((current) => [
        ...current,
        {
          id: optimisticId,
          role: "user",
          parts: [{ type: "text", text: message, state: "done" }],
          metadata: { timestamp: new Date().toISOString() },
        },
      ]);
      setAdmitting(true);

      try {
        const admission = await active.client.agents.send(
          AGENT_NAME,
          active.threadId,
          { message },
        );
        pendingSubmissionRef.current = admission.submissionId;
        setPendingSubmissionId(admission.submissionId);
        setAdmitting(false);
        setOptimisticMessages((current) =>
          current.map((entry) =>
            entry.id === optimisticId
              ? { ...entry, submissionId: admission.submissionId }
              : entry,
          ),
        );
        const currentSnapshot = active.observation.getSnapshot();
        reconcilePending(currentSnapshot);
        // Admission creates the durable instance. Always rehydrate from that
        // authoritative point so an earlier in-flight 404 cannot strand the UI
        // in an absent/sending state.
        active.observation.refresh();
        return admission;
      } catch (error) {
        setOptimisticMessages((current) =>
          current.filter((entry) => entry.id !== optimisticId),
        );
        pendingSubmissionRef.current = null;
        busyRef.current = false;
        setPendingSubmissionId(null);
        setAdmitting(false);
        throw error;
      }
    },
    [historyReady, reconcilePending, threadId],
  );

  const abort = useCallback(async () => {
    if (abortPromiseRef.current) return abortPromiseRef.current;
    const active = activeRef.current;
    if (!active || active.threadId !== threadId || !busyRef.current)
      return false;
    const operation = (async () => {
      setAborting(true);
      try {
        const result = await active.client.agents.abort(
          AGENT_NAME,
          active.threadId,
        );
        return result.aborted;
      } finally {
        setAborting(false);
        abortPromiseRef.current = null;
      }
    })();
    abortPromiseRef.current = operation;
    return operation;
  }, [threadId]);

  const resetThreadObservation = useCallback(() => {
    activeRef.current?.observation.close();
    activeRef.current = null;
    setThreadId(null);
    setSnapshot(INITIAL_SNAPSHOT);
    setOptimisticMessages([]);
    pendingSubmissionRef.current = null;
    busyRef.current = false;
    setPendingSubmissionId(null);
    setAdmitting(false);
    setAborting(false);
    abortPromiseRef.current = null;
  }, []);

  const claimSelectedThread = useCallback(() => {
    void claimStorefrontAssistantConversationId()
      .then((claimed) => {
        if (mountedRef.current) setThreadId(claimed);
      })
      .catch(() => undefined);
  }, []);

  const newConversation = useCallback(() => {
    if (sending || aborting) return false;
    resetThreadObservation();
    if (threadId) {
      setRecentThreadIds(persistRecentThreads([threadId, ...recentThreadIds]));
    }
    rotateStorefrontAssistantConversationClaim();
    claimSelectedThread();
    return true;
  }, [
    claimSelectedThread,
    recentThreadIds,
    resetThreadObservation,
    sending,
    aborting,
    threadId,
  ]);

  const resumeConversation = useCallback(
    (selectedThreadId: string) => {
      if (
        sending ||
        aborting ||
        !THREAD_ID_PATTERN.test(selectedThreadId) ||
        !recentThreadIds.includes(selectedThreadId)
      ) {
        return false;
      }
      if (!switchStorefrontAssistantConversationClaim(selectedThreadId))
        return false;
      const nextRecent = persistRecentThreads([
        ...(threadId ? [threadId] : []),
        ...recentThreadIds.filter(
          (candidate) => candidate !== selectedThreadId,
        ),
      ]);
      resetThreadObservation();
      setRecentThreadIds(nextRecent);
      claimSelectedThread();
      return true;
    },
    [
      aborting,
      claimSelectedThread,
      recentThreadIds,
      resetThreadObservation,
      sending,
      threadId,
    ],
  );

  const resumePreviousConversation = useCallback(
    () => (recentThreadIds[0] ? resumeConversation(recentThreadIds[0]) : false),
    [recentThreadIds, resumeConversation],
  );

  const retry = useCallback(() => {
    const error = snapshot.error;
    const fatal =
      error instanceof FlueApiError &&
      (error.status === 401 || error.status === 403);
    if (fatal) {
      resetThreadObservation();
      rotateStorefrontAssistantConversationClaim();
      claimSelectedThread();
      return;
    }
    if (activeRef.current) activeRef.current.observation.refresh();
    else setReconnectToken((value) => value + 1);
  }, [claimSelectedThread, resetThreadObservation, snapshot.error]);

  return {
    threadId,
    messages,
    pendingSubmissionId,
    sending,
    aborting,
    state,
    historyReady,
    sendMessage,
    abort,
    newConversation,
    canResumePreviousConversation: recentThreadIds.length > 0,
    recentThreads: recentThreadIds.map(
      (recentThreadId, index): StorefrontRecentThread => ({
        threadId: recentThreadId,
        label: index === 0 ? "Previous thread" : `${index + 1} threads back`,
      }),
    ),
    resumeConversation,
    resumePreviousConversation,
    retry,
  };
}
