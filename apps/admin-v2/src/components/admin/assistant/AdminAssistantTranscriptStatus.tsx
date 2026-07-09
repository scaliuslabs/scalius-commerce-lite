import { Check, CloudOff, Loader2, RefreshCw } from "lucide-react";

import { cn } from "@scalius/shared/utils";

import { Button } from "../../ui/button";
import type { AdminAssistantTranscriptConnectionState } from "./useAdminAssistantTranscript";

interface AdminAssistantTranscriptStatusProps {
  state: AdminAssistantTranscriptConnectionState;
  onRetry: () => void;
}

export function AdminAssistantTranscriptStatus({
  state,
  onRetry,
}: AdminAssistantTranscriptStatusProps) {
  if (state.kind === "idle") return null;

  const Icon = state.kind === "connecting"
    ? Loader2
    : state.kind === "connected"
      ? Check
      : CloudOff;

  return (
    <div
      role={state.kind === "disconnected" ? "alert" : "status"}
      aria-live={state.kind === "disconnected" ? "assertive" : "polite"}
      data-assistant-transcript-state={state.kind}
      className={cn(
        "mx-3 mt-2 flex min-h-8 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] leading-4",
        state.kind === "disconnected"
          ? "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-100"
          : "border-border/70 bg-muted/30 text-muted-foreground",
      )}
    >
      <Icon
        className={cn(
          "h-3.5 w-3.5 shrink-0",
          state.kind === "connecting" &&
            "animate-spin motion-reduce:animate-none",
        )}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">{state.message}</span>
      {state.kind === "disconnected" ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 px-2 text-[11px]"
          aria-label="Retry transcript connection"
          onClick={onRetry}
        >
          <RefreshCw className="h-3 w-3" aria-hidden="true" />
          Retry
        </Button>
      ) : null}
    </div>
  );
}
