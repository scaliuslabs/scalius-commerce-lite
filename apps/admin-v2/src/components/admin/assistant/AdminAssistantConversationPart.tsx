import type { FlueConversationPart } from "@flue/sdk";
import { Paperclip } from "lucide-react";
import { memo } from "react";

import { AdminAssistantMessageContent } from "./AdminAssistantMessageContent";
import { AdminAssistantToolActivity } from "./AdminAssistantToolActivity";

interface AdminAssistantConversationPartProps {
  part: FlueConversationPart;
}

export const AdminAssistantConversationPart = memo(
  function AdminAssistantConversationPart({
    part,
  }: AdminAssistantConversationPartProps) {
    if (part.type === "text") {
      return <AdminAssistantMessageContent content={part.text} />;
    }
  if (part.type === "reasoning") {
      return null;
    }
    if (part.type === "dynamic-tool") {
      return <AdminAssistantToolActivity part={part} />;
    }
    return (
      <span className="my-2 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/70 bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground">
        <Paperclip className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{part.filename ?? "Attachment"}</span>
      </span>
    );
  },
);
