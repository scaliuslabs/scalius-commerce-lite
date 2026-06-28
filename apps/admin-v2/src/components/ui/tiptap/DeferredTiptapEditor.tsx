import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@scalius/shared/utils";
import { RichContent } from "../rich-content";

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
}: DeferredTiptapEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isAliveRef = useRef(true);
  const mountRequestedRef = useRef(false);
  const [shouldMountEditor, setShouldMountEditor] = useState(false);
  const [autoFocusEditor, setAutoFocusEditor] = useState(false);
  const hasContent = hasRenderableContent(content);

  const mountEditor = useCallback(() => {
    setAutoFocusEditor(true);
    if (shouldMountEditor || mountRequestedRef.current) return;

    mountRequestedRef.current = true;
    void loadTiptapEditorModule().finally(() => {
      if (isAliveRef.current) {
        setShouldMountEditor(true);
      }
    });
  }, [shouldMountEditor]);

  useEffect(() => () => {
    isAliveRef.current = false;
  }, []);

  useEffect(() => {
    if (shouldMountEditor || typeof window === "undefined") return undefined;

    let idleHandle: number | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let observer: IntersectionObserver | null = null;

    const preloadEditor = () => {
      void loadTiptapEditorModule();
    };

    const schedulePreload = () => {
      if ("requestIdleCallback" in window) {
        idleHandle = window.requestIdleCallback(preloadEditor, { timeout: 1200 });
        return;
      }
      timeoutHandle = setTimeout(preloadEditor, 250);
    };

    if ("IntersectionObserver" in window && containerRef.current) {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer?.disconnect();
            schedulePreload();
          }
        },
        { rootMargin: "180px" },
      );
      observer.observe(containerRef.current);
    } else {
      schedulePreload();
    }

    return () => {
      observer?.disconnect();
      if (idleHandle !== null && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleHandle);
      }
      if (timeoutHandle) clearTimeout(timeoutHandle);
    };
  }, [shouldMountEditor]);

  if (shouldMountEditor) {
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
          autoFocus={autoFocusEditor}
        />
      </Suspense>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "overflow-hidden rounded-md border bg-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className,
      )}
      role="textbox"
      tabIndex={0}
      aria-multiline="true"
      aria-label="Rich text editor"
      onFocus={mountEditor}
      onPointerDown={mountEditor}
    >
      <div
        className={cn(
          "cursor-text p-4 text-sm",
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
    </div>
  );
}
