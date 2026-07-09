import { useCallback, useEffect, useRef, useState } from "react";

import {
  appendAdminConversationMessage,
  pollAdminConversationEvents,
  readAdminConversationEvents,
  type AdminConversationEvent,
  type AdminConversationMessageEvent,
  type AppendAdminConversationMessageInput,
} from "../../../lib/admin-assistant-conversation";

import { getOrCreateAdminAssistantConversationId } from "./admin-assistant-transcript";

export type AdminAssistantTranscriptConnectionState =
  | { kind: "idle"; message: string }
  | { kind: "connecting"; message: string }
  | { kind: "connected"; message: string }
  | { kind: "disconnected"; message: string };

interface UseAdminAssistantTranscriptOptions {
  open: boolean;
  onEvents: (events: readonly AdminConversationEvent[]) => void;
}

interface AdminAssistantTranscriptController {
  state: AdminAssistantTranscriptConnectionState;
  appendMessage: (
    input: AppendAdminConversationMessageInput,
  ) => Promise<AdminConversationMessageEvent | null>;
  retry: () => void;
}

const INITIAL_STATE: AdminAssistantTranscriptConnectionState = {
  kind: "idle",
  message: "Conversation transcript is idle.",
};

export function useAdminAssistantTranscript({
  open,
  onEvents,
}: UseAdminAssistantTranscriptOptions): AdminAssistantTranscriptController {
  const onEventsRef = useRef(onEvents);
  const conversationIdRef = useRef<string | null>(null);
  const connectionControllerRef = useRef<AbortController | null>(null);
  const connectionGenerationRef = useRef(0);
  const openRef = useRef(open);
  const [state, setState] = useState<AdminAssistantTranscriptConnectionState>(
    INITIAL_STATE,
  );

  onEventsRef.current = onEvents;
  openRef.current = open;

  const conversationId = useCallback(() => {
    conversationIdRef.current ??=
      getOrCreateAdminAssistantConversationId();
    return conversationIdRef.current;
  }, []);

  const disconnect = useCallback((message: string) => {
    connectionGenerationRef.current += 1;
    connectionControllerRef.current?.abort();
    connectionControllerRef.current = null;
    if (openRef.current) setState({ kind: "disconnected", message });
  }, []);

  const connect = useCallback(() => {
    const generation = connectionGenerationRef.current + 1;
    connectionGenerationRef.current = generation;
    connectionControllerRef.current?.abort();
    const controller = new AbortController();
    connectionControllerRef.current = controller;
    setState({
      kind: "connecting",
      message: "Restoring this tab's assistant transcript…",
    });

    void (async () => {
      try {
        let cursor = 0;
        while (!controller.signal.aborted) {
          const replay = await readAdminConversationEvents(conversationId(), {
            after: cursor,
            limit: 100,
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
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
          generation !== connectionGenerationRef.current
        ) {
          return;
        }
        setState({
          kind: "connected",
          message: "Session transcript connected.",
        });

        await pollAdminConversationEvents({
          conversationId: conversationId(),
          after: cursor,
          limit: 100,
          signal: controller.signal,
          onEvents: (events) => {
            if (!controller.signal.aborted) onEventsRef.current(events);
          },
        });
        if (
          !controller.signal.aborted &&
          generation === connectionGenerationRef.current
        ) {
          disconnect(
            "Session transcript disconnected. New messages remain in this open panel until you retry.",
          );
        }
      } catch {
        if (
          controller.signal.aborted ||
          generation !== connectionGenerationRef.current
        ) {
          return;
        }
        disconnect(
          "Session transcript is unavailable. New messages remain in this open panel until you retry.",
        );
      }
    })();
  }, [conversationId, disconnect]);

  useEffect(() => {
    if (!open) {
      connectionGenerationRef.current += 1;
      connectionControllerRef.current?.abort();
      connectionControllerRef.current = null;
      setState(INITIAL_STATE);
      return undefined;
    }

    connect();
    return () => {
      connectionGenerationRef.current += 1;
      connectionControllerRef.current?.abort();
      connectionControllerRef.current = null;
    };
  }, [connect, open]);

  const appendMessage = useCallback(
    async (
      input: AppendAdminConversationMessageInput,
    ): Promise<AdminConversationMessageEvent | null> => {
      try {
        const result = await appendAdminConversationMessage(
          conversationId(),
          input,
        );
        return result.event.type === "message.appended" ? result.event : null;
      } catch {
        disconnect(
          "Session transcript is unavailable. New messages remain in this open panel until you retry.",
        );
        return null;
      }
    },
    [conversationId, disconnect],
  );

  return { state, appendMessage, retry: connect };
}
