import {
  Loader2,
  SendHorizontal,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";

import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";

interface AdminAssistantComposerProps {
  draft: string;
  sending: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function AdminAssistantComposer({
  draft,
  sending,
  textareaRef,
  onDraftChange,
  onSubmit,
}: AdminAssistantComposerProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <form
      method="post"
      noValidate
      className="border-t border-border/80 bg-background px-3 pb-3 pt-2.5"
      onSubmit={onSubmit}
    >
      <label htmlFor="admin-assistant-message" className="sr-only">
        Message admin assistant
      </label>
      <div className="rounded-xl border border-border bg-muted/20 p-1.5 shadow-sm transition-colors focus-within:border-primary/50 focus-within:bg-background focus-within:ring-2 focus-within:ring-primary/10">
        <Textarea
          ref={textareaRef}
          id="admin-assistant-message"
          aria-label="Message admin assistant"
          aria-describedby="admin-assistant-composer-help"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about this page or plan your next task…"
          rows={2}
          disabled={sending}
          className="max-h-40 min-h-[50px] resize-none border-0 bg-transparent px-2 py-1.5 text-sm shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center justify-between gap-2 px-1 pt-1">
          <p id="admin-assistant-composer-help" className="text-[10px] text-muted-foreground">
            Enter to send · Shift + Enter for a new line
          </p>
          <Button
            type="submit"
            size="sm"
            className="h-8 gap-1.5 rounded-lg px-2.5 text-xs"
            disabled={sending || draft.trim().length === 0}
            aria-label="Send assistant message"
          >
            {sending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : (
              <SendHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Send
          </Button>
        </div>
      </div>
    </form>
  );
}
