import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@scalius/shared/utils";
import { hasRenderableHtmlContent } from "@scalius/shared/html-sanitize";
import { RichContent } from "../rich-content";
import { Button } from "../button";
import { Skeleton } from "../skeleton";
import { TiptapToolbarSkeleton } from "./TiptapToolbarSkeleton";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { richTextMessages } from "~/i18n/rich-text";

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
  const t = useMessages(richTextMessages);
  return (
    <div
      aria-busy={failed ? undefined : "true"}
      aria-label={failed ? undefined : t("loading", { name: ariaLabel })}
      className={cn(
        "w-full min-w-0 overflow-hidden rounded-xl border border-input bg-card",
        getDeferredEditorMinHeightClass(Boolean(compact)),
        className,
      )}
    >
      {failed ? (
        <div
          role="alert"
          className="flex min-h-[inherit] flex-col items-center justify-center gap-3 p-4 text-center"
        >
          <p className="text-body text-muted-foreground">{t("loadFailed")}</p>
          <Button type="button" variant="outline" onClick={onRetry}>
            {t("retry")}
          </Button>
        </div>
      ) : (
        <>
          <TiptapToolbarSkeleton compact={Boolean(compact)} />
          <div className={cn("overflow-y-auto border-t", getDeferredEditorViewportClass(Boolean(compact)))}>
            <div className="p-4">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="mt-3 h-4 w-1/2" />
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
  placeholder: placeholderProp,
  className,
  compact = false,
  ariaLabel: ariaLabelProp,
}: DeferredTiptapEditorProps) {
  // Defaults follow the dashboard language.
  const r = useMessages(resourceMessages);
  const t = useMessages(richTextMessages);
  const placeholder = placeholderProp ?? r("writeSomething");
  const ariaLabel = ariaLabelProp ?? r("richText");
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
          aria-label={t("loading", { name: ariaLabel })}
          className={cn(
            "w-full min-w-0 overflow-hidden rounded-xl border border-input bg-card",
            className,
          )}
        >
          <TiptapToolbarSkeleton compact={compact} />
          <div className={cn("cursor-text overflow-y-auto border-t text-body", getDeferredEditorViewportClass(compact))}>
            <div
              className={cn(
                "min-h-[200px] max-w-none p-4",
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
