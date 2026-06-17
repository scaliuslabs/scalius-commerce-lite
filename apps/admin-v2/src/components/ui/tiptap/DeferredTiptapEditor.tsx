import { lazy, Suspense, useState } from "react";
import { PencilLine } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Button } from "../button";
import { RichContent } from "../rich-content";

const TiptapEditor = lazy(() =>
  import("./TiptapEditor").then((module) => ({
    default: module.TiptapEditor,
  })),
);

const RICH_CONTENT_BLOCK_RE = /<(img|video|iframe|table|hr)\b/i;

function hasRenderableContent(content: string) {
  const text = content
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .trim();

  return text.length > 0 || RICH_CONTENT_BLOCK_RE.test(content);
}

interface DeferredTiptapEditorProps {
  content: string;
  onChange: (content: string) => void;
  placeholder?: string;
  className?: string;
  compact?: boolean;
  editLabel?: string;
}

function EditorLoadingShell({
  className,
  compact,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn("overflow-hidden rounded-md border bg-background", className)}>
      <div className="h-10 border-b bg-muted/30 p-2">
        <div className="h-4 w-36 animate-pulse rounded bg-muted" />
      </div>
      <div className={cn("p-4", compact ? "min-h-[180px]" : "min-h-[200px]")}>
        <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
        <div className="mt-3 h-4 w-1/2 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}

export function DeferredTiptapEditor({
  content,
  onChange,
  placeholder = "Write something...",
  className,
  compact = false,
  editLabel = "Edit",
}: DeferredTiptapEditorProps) {
  const [isEditing, setIsEditing] = useState(false);
  const hasContent = hasRenderableContent(content);

  if (isEditing) {
    return (
      <Suspense
        fallback={
          <EditorLoadingShell className={className} compact={compact} />
        }
      >
        <TiptapEditor
          content={content}
          onChange={onChange}
          placeholder={placeholder}
          className={className}
          compact={compact}
        />
      </Suspense>
    );
  }

  return (
    <div className={cn("overflow-hidden rounded-md border bg-background", className)}>
      <div
        className={cn(
          "p-4 text-sm",
          compact ? "min-h-[180px]" : "min-h-[200px]",
        )}
      >
        <div
          className={cn(
            "max-h-64 overflow-y-auto rounded-sm pr-2 leading-6",
            hasContent ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {hasContent ? (
            <RichContent content={content} variant="compact" />
          ) : (
            placeholder
          )}
        </div>
      </div>
      <div className="flex justify-end border-t bg-muted/20 px-3 py-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Edit rich text content"
          onClick={() => setIsEditing(true)}
        >
          <PencilLine className="h-3.5 w-3.5" />
          {editLabel}
        </Button>
      </div>
    </div>
  );
}
