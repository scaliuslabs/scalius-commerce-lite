import { lazy, Suspense, useMemo, useState } from "react";
import { PencilLine } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Button } from "../button";

const TiptapEditor = lazy(() =>
  import("./TiptapEditor").then((module) => ({
    default: module.TiptapEditor,
  })),
);

interface DeferredTiptapEditorProps {
  content: string;
  onChange: (content: string) => void;
  placeholder?: string;
  className?: string;
  compact?: boolean;
  editLabel?: string;
}

const entityMap: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function safeCodePoint(value: number, fallback: string): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) {
    return fallback;
  }

  return String.fromCodePoint(value);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (match, code: string) =>
      safeCodePoint(Number(code), match),
    )
    .replace(/&#x([\da-f]+);/gi, (match, code: string) =>
      safeCodePoint(Number.parseInt(code, 16), match),
    )
    .replace(/&([a-z]+);/gi, (match, entity: string) => {
      return entityMap[entity.toLowerCase()] ?? match;
    });
}

function toPlainTextPreview(content: string): string {
  return decodeHtmlEntities(
    content
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
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
  const preview = useMemo(() => toPlainTextPreview(content), [content]);

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
            "max-h-32 overflow-hidden whitespace-pre-wrap leading-6",
            preview ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {preview || placeholder}
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
