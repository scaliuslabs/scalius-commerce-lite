import { useEffect, useMemo, useState, useRef } from "react";
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
import { shouldApplyExternalTiptapContent } from "./tiptap-content-sync";
import { shouldExitRichTextFullscreen } from "./tiptap-fullscreen";

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
  const hasAutoFocusedRef = useRef(false);
  const editorAreaRef = useRef<HTMLDivElement>(null);
  const contentWrapperRef = useRef<HTMLDivElement>(null);
  const lastExternalContentRef = useRef(content);
  const editorViewportHeight = compact ? "200px" : "300px";
  const hasInitialContent = hasRenderableHtmlContent(content);
  const sanitizedInitialContent = useMemo(() => sanitizeHtml(content), [content]);

  // Handle Escape key and body scroll lock for fullscreen
  useEffect(() => {
    if (!isFullscreen) return;
    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyPaddingRight = document.body.style.paddingRight;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const scrollbarWidth =
      window.innerWidth - document.documentElement.clientWidth;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (shouldExitRichTextFullscreen(e, contentWrapperRef.current)) {
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

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      document.body.style.paddingRight = previousBodyPaddingRight;
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.body.classList.remove("editor-fullscreen-active");
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
      onChange(editor.getHTML());
    },
    editorProps: {
      attributes: {
        class:
          "max-w-none p-4 min-h-[200px] focus-visible:outline-none text-sm",
        role: "textbox",
        "aria-label": ariaLabel,
        "aria-multiline": "true",
      },
    },
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
  });

  useEffect(() => {
    if (!editorInstance) return;
    if (
      shouldApplyExternalTiptapContent({
        incomingContent: content,
        lastExternalContent: lastExternalContentRef.current,
        editorContent: editorInstance.getHTML(),
      })
    ) {
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
      className={cn(
        "flex flex-col bg-background transition-colors",
        isFullscreen
          ? "fixed inset-0 z-[9999] h-dvh w-full"
          : "border rounded-md",
        !isFullscreen && className,
      )}
    >
      {/* Fullscreen header */}
      {isFullscreen && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2 sm:px-4">
          <span className="text-sm font-medium text-muted-foreground">
            Edit content
          </span>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground hidden sm:inline">
              Press <kbd className="px-1.5 py-0.5 rounded border bg-muted text-[10px] font-mono">Esc</kbd> to exit
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Exit fullscreen"
              onClick={() => setIsFullscreen(false)}
              className="gap-1.5"
            >
              <Minimize2 className="h-3.5 w-3.5" />
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
        className={cn(
          "overflow-y-auto border-t",
          isFullscreen ? "flex-1 bg-muted/30" : "",
        )}
        style={!isFullscreen ? { minHeight: editorViewportHeight, maxHeight: editorViewportHeight } : undefined}
        onClick={() => {
          // Click-to-focus: when user clicks the editing area background, focus the editor
          if (isFullscreen && editorInstance && !editorInstance.isFocused) {
            editorInstance.commands.focus("end");
          }
        }}
      >
        <div className={cn(
          isFullscreen
            ? "mx-auto min-h-full w-full max-w-4xl bg-background px-3 py-4 shadow-sm sm:border-x sm:border-border/40 sm:px-8 sm:py-6"
            : ""
        )}>
          {editorInstance ? (
            <EditorContent editor={editorInstance} className="max-w-none" />
          ) : hasInitialContent ? (
            <div
              className="ProseMirror max-w-none p-4 min-h-[200px] text-sm"
              dangerouslySetInnerHTML={{ __html: sanitizedInitialContent }}
            />
          ) : (
            <div className="ProseMirror max-w-none p-4 min-h-[200px] text-sm">
              <p className="is-editor-empty" data-placeholder={placeholder}>
                <br />
              </p>
            </div>
          )}
        </div>
      </div>
      {/* CSS to ensure layout elements like sticky headers/sidebars are pushed below the fullscreen editor */}
      <style suppressHydrationWarning>{`
        body.editor-fullscreen-active header,
        body.editor-fullscreen-active aside,
        body.editor-fullscreen-active nav {
          z-index: 0 !important;
        }
      `}</style>
    </div>
  );

  return editorContent;
}
