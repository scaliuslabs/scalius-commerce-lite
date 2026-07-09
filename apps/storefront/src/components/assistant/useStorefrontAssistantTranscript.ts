import { useCallback, useEffect, useRef, useState } from "react";

import {
  appendStorefrontConversationMessage,
  readStorefrontConversationEvents,
  type AppendStorefrontConversationMessageInput,
  type StorefrontConversationMessageEvent,
  StorefrontConversationTransportError,
} from "./storefront-assistant-conversation";
import {
  claimStorefrontAssistantConversationId,
  rotateStorefrontAssistantConversationClaim,
} from
  "./storefront-assistant-transcript";

export type StorefrontAssistantTranscriptState =
  | { kind: "idle"; message: string }
  | { kind: "connecting"; message: string }
  | { kind: "connected"; message: string }
  | { kind: "disconnected"; message: string };

interface UseStorefrontAssistantTranscriptOptions {
  open: boolean;
  onEvents: (events: readonly StorefrontConversationMessageEvent[]) => void;
}

const INITIAL_STATE: StorefrontAssistantTranscriptState = {
  kind: "idle",
  message: "Conversation transcript is idle.",
};

export function useStorefrontAssistantTranscript({
  open,
  onEvents,
}: UseStorefrontAssistantTranscriptOptions) {
  const onEventsRef = useRef(onEvents);
  const conversationIdRef = useRef<Promise<string> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const openRef = useRef(open);
  const bootstrapRef = useRef<Promise<boolean> | null>(null);
  const [state, setState] = useState<StorefrontAssistantTranscriptState>(
    INITIAL_STATE,
  );

  onEventsRef.current = onEvents;
  openRef.current = open;

  const conversationId = useCallback(() => {
    conversationIdRef.current ??=
      claimStorefrontAssistantConversationId();
    return conversationIdRef.current;
  }, []);

  const disconnect = useCallback((message: string) => {
    generationRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    bootstrapRef.current = Promise.resolve(false);
    if (openRef.current) setState({ kind: "disconnected", message });
  }, []);

  useEffect(() => {
    // Claim the per-tab ID before the panel opens. Duplicated/opener tabs can
    // copy sessionStorage even while the original assistant is collapsed.
    void conversationId().catch(() => undefined);
  }, [conversationId]);

  const connect = useCallback(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({
      kind: "connecting",
      message: "Restoring this tab's private assistant transcript…",
    });

    let settleBootstrap: (connected: boolean) => void = () => undefined;
    bootstrapRef.current = new Promise<boolean>((resolve) => {
      settleBootstrap = resolve;
    });

    void (async () => {
      let settled = false;
      const settle = (connected: boolean) => {
        if (settled) return;
        settled = true;
        settleBootstrap(connected);
      };
      try {
        const claimedConversationId = await conversationId();
        let cursor = 0;
        while (!controller.signal.aborted) {
          const replay = await readStorefrontConversationEvents(
            claimedConversationId,
            { after: cursor, limit: 100, signal: controller.signal },
          );
          if (controller.signal.aborted) {
            settle(false);
            return;
          }
          onEventsRef.current(replay.events);
          const previousCursor = cursor;
          cursor = Math.max(cursor, replay.cursor);
          if (!replay.hasMore) break;
          if (cursor === previousCursor) {
            throw new Error("Conversation replay cursor did not advance.");
          }
        }

        if (
          controller.signal.aborted ||
          generation !== generationRef.current
        ) {
          settle(false);
          return;
        }
        setState({
          kind: "connected",
          message: "This tab's private transcript is restored.",
        });
        settle(true);
      } catch (error) {
        settle(false);
        if (
          controller.signal.aborted ||
          generation !== generationRef.current
        ) {
          return;
        }
        if (
          error instanceof StorefrontConversationTransportError &&
          (error.status === 401 || error.status === 409)
        ) {
          rotateStorefrontAssistantConversationClaim();
          conversationIdRef.current = null;
          disconnect(
            "This transcript expired. Retry to start a fresh private transcript for this tab.",
          );
          return;
        }
        disconnect(
          "Private transcript is unavailable. Shopping help still works in this open panel.",
        );
      }
    })();
  }, [conversationId, disconnect]);

  useEffect(() => {
    if (!open) {
      generationRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
      bootstrapRef.current = null;
      setState(INITIAL_STATE);
      return undefined;
    }
    connect();
    return () => {
      generationRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [connect, open]);

  const appendMessage = useCallback(
    async (
      input: AppendStorefrontConversationMessageInput,
    ): Promise<StorefrontConversationMessageEvent | null> => {
      try {
        if (bootstrapRef.current && !(await bootstrapRef.current)) return null;
        return await appendStorefrontConversationMessage(
          await conversationId(),
          input,
        );
      } catch (error) {
        if (
          error instanceof StorefrontConversationTransportError &&
          (error.status === 401 || error.status === 409)
        ) {
          rotateStorefrontAssistantConversationClaim();
          conversationIdRef.current = null;
          disconnect(
            "This transcript expired. Retry to start a fresh private transcript for this tab.",
          );
          return null;
        }
        disconnect(
          "Private transcript is unavailable. Shopping help still works in this open panel.",
        );
        return null;
      }
    },
    [conversationId, disconnect],
  );

  return {
    state,
    appendMessage,
    retry: connect,
    getConversationId: conversationId,
  };
}
