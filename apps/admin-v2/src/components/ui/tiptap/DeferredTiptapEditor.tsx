import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { SCALIUS_COMPUTER_RICH_TEXT_FILL_EVENT } from "@scalius/shared/assistant-computer";
import { sanitizeHtml } from "@scalius/shared/html-sanitize";
import { cn } from "@scalius/shared/utils";
import { RichContent } from "../rich-content";
import { TiptapToolbarSkeleton } from "./TiptapToolbarSkeleton";

let tiptapEditorModulePromise: Promise<{
  default: typeof import("./TiptapEditor").TiptapEditor;
}> | null = null;

function loadTiptapEditorModule() {
  tiptapEditorModulePromise ??= import("./TiptapEditor").then((module) => ({
    default: module.TiptapEditor,
  }));
  return tiptapEditorModulePromise;
}

const TiptapEditor = lazy(() =>
  loadTiptapEditorModule(),
);

const RICH_CONTENT_BLOCK_RE = /<(img|video|iframe|table|hr)\b/i;

function getDeferredEditorMinHeightClass(compact: boolean) {
  return compact ? "min-h-[237px]" : "min-h-[257px]";
}

function getDeferredEditorViewportClass(compact: boolean) {
  return compact ? "h-[200px]" : "h-[300px]";
}

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
}

function EditorLoadingShell({
  className,
  compact,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border bg-background",
        getDeferredEditorMinHeightClass(Boolean(compact)),
        className,
      )}
    >
      <TiptapToolbarSkeleton compact={Boolean(compact)} />
      <div className={cn("overflow-y-auto border-t", getDeferredEditorViewportClass(Boolean(compact)))}>
        <div className="p-4">
          <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
          <div className="mt-3 h-4 w-1/2 animate-pulse rounded bg-muted" />
        </div>
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
}: DeferredTiptapEditorProps) {
  const isAliveRef = useRef(true);
  const richTextBridgeRef = useRef<HTMLDivElement>(null);
  const mountRequestedRef = useRef(false);
  const [shouldMountEditor, setShouldMountEditor] = useState(false);
  const [autoFocusEditor, setAutoFocusEditor] = useState(false);
  const hasContent = hasRenderableContent(content);

  const loadAndMountEditor = useCallback((autoFocus: boolean) => {
    if (autoFocus) setAutoFocusEditor(true);
    if (shouldMountEditor || mountRequestedRef.current) return;

    mountRequestedRef.current = true;
    void loadTiptapEditorModule()
      .then(() => {
        if (isAliveRef.current) {
          setShouldMountEditor(true);
        }
      })
      .catch((error) => {
        mountRequestedRef.current = false;
        console.error("Failed to load rich text editor", error);
      });
  }, [shouldMountEditor]);

  useEffect(() => () => {
    isAliveRef.current = false;
  }, []);

  useEffect(() => {
    const bridge = richTextBridgeRef.current;
    if (!bridge) return undefined;
    const acceptComputerFill = (rawEvent: Event) => {
      const event = rawEvent as CustomEvent<unknown>;
      if (typeof event.detail !== "string" || event.detail.length > 4_000) {
        return;
      }
      onChange(sanitizeHtml(event.detail));
      event.preventDefault();
    };
    bridge.addEventListener(
      SCALIUS_COMPUTER_RICH_TEXT_FILL_EVENT,
      acceptComputerFill,
    );
    return () => {
      bridge.removeEventListener(
        SCALIUS_COMPUTER_RICH_TEXT_FILL_EVENT,
        acceptComputerFill,
      );
    };
  }, [onChange, shouldMountEditor]);

  useEffect(() => {
    loadAndMountEditor(false);
  }, [loadAndMountEditor]);

  if (shouldMountEditor) {
    return (
      <div
        ref={richTextBridgeRef}
        data-scalius-computer-rich-text="sanitized-html"
      >
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
            autoFocus={autoFocusEditor}
          />
        </Suspense>
      </div>
    );
  }

  return (
    <div
      ref={richTextBridgeRef}
      className={cn(
        "overflow-hidden rounded-md border bg-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        getDeferredEditorMinHeightClass(compact),
        className,
      )}
      role="textbox"
      data-scalius-computer-rich-text="sanitized-html"
      tabIndex={0}
      aria-multiline="true"
      aria-label="Rich text editor"
      onFocus={() => loadAndMountEditor(true)}
      onPointerDown={() => loadAndMountEditor(true)}
    >
      <TiptapToolbarSkeleton compact={compact} />
      <div className={cn("cursor-text overflow-y-auto border-t text-sm", getDeferredEditorViewportClass(compact))}>
        <div
          className={cn(
            "min-h-[200px] max-w-none p-4 leading-6",
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
    </div>
  );
}
