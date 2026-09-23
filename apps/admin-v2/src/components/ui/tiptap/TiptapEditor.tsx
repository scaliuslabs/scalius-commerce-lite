import { useEffect, useId, useMemo, useState, useRef, type CSSProperties } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { cn } from "@scalius/shared/utils";
import {
  hasRenderableHtmlContent,
  sanitizeHtml,
} from "@scalius/shared/html-sanitize";
import { Minimize2 } from "lucide-react";
import { Button } from "../button";
import { TiptapMenuBar } from "./TiptapMenuBar";
import { TiptapToolbarSkeleton } from "./TiptapToolbarSkeleton";
import { createTiptapExtensions } from "./tiptap-extensions";
import { reconcileExternalTiptapContent } from "./tiptap-content-sync";
import {
  isolateRichTextFullscreenBackground,
  shouldExitRichTextFullscreen,
} from "./tiptap-fullscreen";

interface TiptapEditorProps {
  content: string;
  onChange: (content: string) => void;
  placeholder?: string;
  className?: string;
  compact?: boolean;
  autoFocus?: boolean;
  ariaLabel?: string;
}

export function TiptapEditor({
  content,
  onChange,
  placeholder = "Write something...",
  className,
  compact = false,
  autoFocus = false,
  ariaLabel = "Rich text content",
}: TiptapEditorProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const fullscreenTitleId = useId();
  const hasAutoFocusedRef = useRef(false);
  const editorAreaRef = useRef<HTMLDivElement>(null);
  const contentWrapperRef = useRef<HTMLDivElement>(null);
  const lastExternalContentRef = useRef(content);
  const pendingLocalContentsRef = useRef<string[]>([]);
  const editorViewportHeight = compact ? "200px" : "300px";
  const hasInitialContent = hasRenderableHtmlContent(content);
  const sanitizedInitialContent = useMemo(() => sanitizeHtml(content), [content]);

  // Handle Escape key and body scroll lock for fullscreen
  useEffect(() => {
    const editorRoot = contentWrapperRef.current;
    if (!isFullscreen || !editorRoot) return;
    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyPaddingRight = document.body.style.paddingRight;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const scrollbarWidth =
      window.innerWidth - document.documentElement.clientWidth;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (shouldExitRichTextFullscreen(e, editorRoot)) {
        setIsFullscreen(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }

    document.body.classList.add("editor-fullscreen-active");
    const restoreBackground = isolateRichTextFullscreenBackground(editorRoot);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      document.body.style.paddingRight = previousBodyPaddingRight;
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.body.classList.remove("editor-fullscreen-active");
      restoreBackground();
      requestAnimationFrame(() => {
        editorRoot
          .querySelector<HTMLButtonElement>('[aria-label="Fullscreen"]')
          ?.focus({ preventScroll: true });
      });
    };
  }, [isFullscreen]);

  // Break out of containing blocks via CSS overrides without unmounting
  useEffect(() => {
    if (!isFullscreen || !contentWrapperRef.current) return;

    const originalStyles = new Map<HTMLElement, string>();
    let el = contentWrapperRef.current.parentElement;

    // Traverse up to document body and strip any properties that create a containing block for fixed positioning
    while (el && el !== document.body && el !== document.documentElement) {
      const style = window.getComputedStyle(el);

      const hasContainingBlock =
        style.transform !== 'none' ||
        style.perspective !== 'none' ||
        style.filter !== 'none' ||
        (style.willChange && style.willChange !== 'auto' && style.willChange !== 'none') ||
        (style.contain && style.contain !== 'none') ||
        (style.backdropFilter && style.backdropFilter !== 'none') ||
        (style.viewTransitionName && style.viewTransitionName !== 'none');

      if (hasContainingBlock) {
        if (!originalStyles.has(el)) originalStyles.set(el, el.getAttribute('style') || '');
        el.style.setProperty('transform', 'none', 'important');
        el.style.setProperty('perspective', 'none', 'important');
        el.style.setProperty('filter', 'none', 'important');
        el.style.setProperty('will-change', 'auto', 'important');
        el.style.setProperty('contain', 'none', 'important');
        el.style.setProperty('backdrop-filter', 'none', 'important');
        el.style.setProperty('view-transition-name', 'none', 'important');
      }

      // Force z-index of all parents to ensure we sit on top of siblings like the sidebar
      const tzIndex = parseInt(style.zIndex);
      if (style.position !== 'static' || !isNaN(tzIndex) || style.isolation === 'isolate' || style.display === 'flex' || style.display === 'grid') {
        if (!originalStyles.has(el)) originalStyles.set(el, el.getAttribute('style') || '');
        el.style.setProperty('z-index', '45', 'important');
        el.style.setProperty('isolation', 'auto', 'important');
      }

      el = el.parentElement;
    }

    return () => {
      originalStyles.forEach((styleStr, element) => {
        if (styleStr === '') {
          element.removeAttribute('style');
        } else {
          element.setAttribute('style', styleStr);
        }
      });
    };
  }, [isFullscreen]);

  const extensions = useMemo(
    () => createTiptapExtensions(placeholder),
    [placeholder],
  );

  const editorInstance = useEditor({
    extensions,
    content,
    onUpdate: ({ editor }) => {
      const nextContent = editor.getHTML();
      const pendingLocalContents = pendingLocalContentsRef.current;
      if (pendingLocalContents.at(-1) !== nextContent) {
        pendingLocalContents.push(nextContent);
        if (pendingLocalContents.length > 50) pendingLocalContents.shift();
      }
      onChange(nextContent);
    },
    editorProps: {
      attributes: {
        class:
          "min-h-52 max-w-none p-4 text-body focus-visible:outline-none",
        role: "textbox",
        "aria-label": ariaLabel,
        "aria-multiline": "true",
      },
    },
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
  });

  useEffect(() => {
    if (!editorInstance) return;
    const reconciliation = reconcileExternalTiptapContent({
      incomingContent: content,
      lastExternalContent: lastExternalContentRef.current,
      editorContent: editorInstance.getHTML(),
      pendingLocalContents: pendingLocalContentsRef.current,
    });
    pendingLocalContentsRef.current = reconciliation.pendingLocalContents;
    if (reconciliation.shouldApply) {
      editorInstance.commands.setContent(content, { emitUpdate: false });
    }
    lastExternalContentRef.current = content;
  }, [content, editorInstance]);

  useEffect(() => {
    if (!autoFocus || !editorInstance || hasAutoFocusedRef.current) {
      return;
    }

    hasAutoFocusedRef.current = true;
    queueMicrotask(() => {
      editorInstance.commands.focus("end", { scrollIntoView: false });
    });
  }, [autoFocus, editorInstance]);

  const editorContent = (
    <div
      ref={contentWrapperRef}
      role={isFullscreen ? "dialog" : undefined}
      aria-modal={isFullscreen ? true : undefined}
      aria-labelledby={isFullscreen ? fullscreenTitleId : undefined}
      className={cn(
        "flex w-full min-w-0 flex-col bg-card",
        isFullscreen ? "fixed inset-0 z-[9999] h-dvh" : "overflow-hidden rounded-xl border border-input",
        !isFullscreen && className,
      )}
    >
      {/* Fullscreen header */}
      {isFullscreen && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2 sm:px-4">
          <span id={fullscreenTitleId} className="text-heading-sm">
            Edit content
          </span>
          <div className="flex items-center gap-3">
            <span className="hidden text-body text-muted-foreground sm:inline">
              Press <kbd>Esc</kbd> to exit
            </span>
            <Button
              type="button"
              variant="outline"
              aria-label="Exit fullscreen"
              onClick={() => setIsFullscreen(false)}
            >
              <Minimize2 />
              Exit fullscreen
            </Button>
          </div>
        </div>
      )}

      {/* Toolbar */}
      {editorInstance ? (
        <TiptapMenuBar
          editor={editorInstance}
          toggleModal={() => {
            setIsFullscreen((prev) => {
              setTimeout(() => {
                editorInstance?.commands.focus();
              }, 50);
              return !prev;
            });
          }}
          compact={isFullscreen ? false : compact}
          isFullscreen={isFullscreen}
          ariaLabel={`${ariaLabel} formatting`}
        />
      ) : (
        <TiptapToolbarSkeleton
          compact={isFullscreen ? false : compact}
          isFullscreen={isFullscreen}
        />
      )}

      {/* Editor content -- always mounted, never unmounts */}
      <div
        ref={editorAreaRef}
        className={cn("overflow-y-auto border-t", isFullscreen ? "flex-1 bg-background" : "h-(--editor-height)")}
        style={{ "--editor-height": editorViewportHeight } as CSSProperties}
        onClick={() => {
          // Click-to-focus: when user clicks the editing area background, focus the editor
          if (isFullscreen && editorInstance && !editorInstance.isFocused) {
            editorInstance.commands.focus("end");
          }
        }}
      >
        <div className={cn(
          isFullscreen
            ? "mx-auto min-h-full w-full max-w-4xl bg-card px-3 py-4 shadow-card sm:px-8 sm:py-6"
            : ""
        )}>
          {editorInstance ? (
            <EditorContent editor={editorInstance} className="max-w-none" />
          ) : hasInitialContent ? (
            <div
              className="ProseMirror min-h-52 max-w-none p-4 text-body"
              dangerouslySetInnerHTML={{ __html: sanitizedInitialContent }}
            />
          ) : (
            <div className="ProseMirror min-h-52 max-w-none p-4 text-body">
              <p className="is-editor-empty" data-placeholder={placeholder}>
                <br />
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return editorContent;
}
