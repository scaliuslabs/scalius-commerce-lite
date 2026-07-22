import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@scalius/shared/utils";
import { hasRenderableHtmlContent } from "@scalius/shared/html-sanitize";
import { RichContent } from "../rich-content";
import { Button } from "../button";
import { TiptapToolbarSkeleton } from "./TiptapToolbarSkeleton";

let tiptapEditorModulePromise: Promise<{
  default: typeof import("./TiptapEditor").TiptapEditor;
}> | null = null;

function loadTiptapEditorModule() {
  tiptapEditorModulePromise ??= import("./TiptapEditor")
    .then((module) => ({
      default: module.TiptapEditor,
    }))
    .catch((error) => {
      tiptapEditorModulePromise = null;
      throw error;
    });
  return tiptapEditorModulePromise;
}

const TiptapEditor = lazy(() =>
  loadTiptapEditorModule(),
);

function getDeferredEditorMinHeightClass(compact: boolean) {
  return compact ? "min-h-[237px]" : "min-h-[257px]";
}

function getDeferredEditorViewportClass(compact: boolean) {
  return compact ? "h-[200px]" : "h-[300px]";
}

interface DeferredTiptapEditorProps {
  content: string;
  onChange: (content: string) => void;
  placeholder?: string;
  className?: string;
  compact?: boolean;
  ariaLabel?: string;
}

function EditorLoadingShell({
  ariaLabel,
  className,
  compact,
  failed = false,
  onRetry,
}: {
  ariaLabel: string;
  className?: string;
  compact?: boolean;
  failed?: boolean;
  onRetry?: () => void;
}) {
  return (
    <div
      aria-busy={failed ? undefined : "true"}
      aria-label={failed ? undefined : `Loading ${ariaLabel}`}
      className={cn(
        "w-full min-w-0 overflow-hidden rounded-md border bg-background transition-colors",
        getDeferredEditorMinHeightClass(Boolean(compact)),
        className,
      )}
    >
      {failed ? (
        <div
          role="alert"
          className="flex min-h-[inherit] flex-col items-center justify-center gap-3 p-4 text-center"
        >
          <p className="text-sm text-muted-foreground">Editor couldn&apos;t load.</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            onClick={onRetry}
          >
            Retry
          </Button>
        </div>
      ) : (
        <>
          <TiptapToolbarSkeleton compact={Boolean(compact)} />
          <div className={cn("overflow-y-auto border-t", getDeferredEditorViewportClass(Boolean(compact)))}>
            <div className="p-4">
              <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
              <div className="mt-3 h-4 w-1/2 animate-pulse rounded bg-muted" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function DeferredTiptapEditor({
  content,
  onChange,
  placeholder = "Write something...",
  className,
  compact = false,
  ariaLabel = "Rich text content",
}: DeferredTiptapEditorProps) {
  const isAliveRef = useRef(true);
  const mountRequestedRef = useRef(false);
  const [shouldMountEditor, setShouldMountEditor] = useState(false);
  const [autoFocusEditor, setAutoFocusEditor] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const hasContent = hasRenderableHtmlContent(content);

  const loadAndMountEditor = useCallback((autoFocus: boolean) => {
    if (autoFocus) setAutoFocusEditor(true);
    if (shouldMountEditor || mountRequestedRef.current) return;

    setLoadFailed(false);
    mountRequestedRef.current = true;
    void loadTiptapEditorModule()
      .then(() => {
        if (isAliveRef.current) {
          setShouldMountEditor(true);
        }
      })
      .catch((error) => {
        mountRequestedRef.current = false;
        if (isAliveRef.current) setLoadFailed(true);
        console.error("Failed to load rich text editor", error);
      });
  }, [shouldMountEditor]);

  useEffect(() => {
    isAliveRef.current = true;
    return () => {
      isAliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    loadAndMountEditor(false);
  }, [loadAndMountEditor]);

  if (shouldMountEditor) {
    return (
      <div className="w-full min-w-0">
        <Suspense
          fallback={
            <EditorLoadingShell
              ariaLabel={ariaLabel}
              className={className}
              compact={compact}
            />
          }
        >
          <TiptapEditor
            content={content}
            onChange={onChange}
            placeholder={placeholder}
            className={className}
            compact={compact}
            autoFocus={autoFocusEditor}
            ariaLabel={ariaLabel}
          />
        </Suspense>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "w-full min-w-0",
        getDeferredEditorMinHeightClass(compact),
      )}
      onPointerDown={() => loadAndMountEditor(true)}
    >
      {loadFailed ? (
        <EditorLoadingShell
          ariaLabel={ariaLabel}
          className={className}
          compact={compact}
          failed
          onRetry={() => loadAndMountEditor(true)}
        />
      ) : (
        <div
          aria-busy="true"
          aria-label={`Loading ${ariaLabel}`}
          className={cn(
            "w-full min-w-0 overflow-hidden rounded-md border bg-background transition-colors",
            className,
          )}
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
      )}
    </div>
  );
}
