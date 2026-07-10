import type { FlueConversationPart } from "@flue/sdk";
import { CheckCircle2, Loader2, MousePointerClick, XCircle } from "lucide-react";
import { memo } from "react";

import { cn } from "@scalius/shared/utils";

type DynamicToolPart = Extract<
  FlueConversationPart,
  { type: "dynamic-tool" }
>;

interface AdminAssistantToolActivityProps {
  part: DynamicToolPart;
}

export const AdminAssistantToolActivity = memo(
  function AdminAssistantToolActivity({
    part,
  }: AdminAssistantToolActivityProps) {
    const presentation = describeToolActivity(part);
    const Icon = presentation.icon;

    return (
      <div
        role={presentation.busy ? "status" : undefined}
        aria-busy={presentation.busy || undefined}
        data-assistant-tool={part.toolName}
        data-assistant-tool-state={part.state}
        className={cn(
          "my-2 inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] leading-4",
          presentation.tone === "error"
            ? "border-destructive/25 bg-destructive/5 text-destructive"
            : "border-border/70 bg-muted/30 text-muted-foreground",
        )}
      >
        <Icon
          className={cn(
            "h-3 w-3 shrink-0",
            presentation.busy &&
              "animate-spin motion-reduce:animate-none",
          )}
          aria-hidden="true"
        />
        <span className="truncate">{presentation.label}</span>
      </div>
    );
  },
);

function describeToolActivity(part: DynamicToolPart): {
  label: string;
  busy: boolean;
  tone: "neutral" | "error";
  icon: typeof Loader2;
} {
  if (part.state === "output-error") {
    return {
      label:
        part.toolName === "computer"
          ? "Page command failed safely"
          : "Scalius check failed",
      busy: false,
      tone: "error",
      icon: XCircle,
    };
  }
  if (part.toolName === "computer") {
    return {
      label:
        part.state === "input-available"
          ? "Preparing page command…"
          : "Page command recorded",
      busy: part.state === "input-available",
      tone: "neutral",
      icon: part.state === "input-available" ? Loader2 : MousePointerClick,
    };
  }
  if (part.toolName === "scalius") {
    return {
      label:
        part.state === "input-available"
          ? "Checking Scalius…"
          : "Scalius result ready",
      busy: part.state === "input-available",
      tone: "neutral",
      icon: part.state === "input-available" ? Loader2 : CheckCircle2,
    };
  }
  return {
    label:
      part.state === "input-available"
        ? "Using assistant tool…"
        : "Assistant tool finished",
    busy: part.state === "input-available",
    tone: "neutral",
    icon: part.state === "input-available" ? Loader2 : CheckCircle2,
  };
}
