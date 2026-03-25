import { useEffect, useState, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { cn } from "@scalius/shared/utils";
import { Minimize2 } from "lucide-react";
import { Button } from "../button";
import { TiptapMenuBar } from "./TiptapMenuBar";
import { createTiptapExtensions } from "./tiptap-extensions";

interface TiptapEditorProps {
  content: string;
  onChange: (content: string) => void;
  placeholder?: string;
  className?: string;
  compact?: boolean;
}

export function TiptapEditor({
  content,
  onChange,
  placeholder = "Write something...",
  className,
  compact = false,
}: TiptapEditorProps) {
  const [isMounted, setIsMounted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const editorAreaRef = useRef<HTMLDivElement>(null);
  const contentWrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Handle Escape key and body scroll lock for fullscreen
  useEffect(() => {
    if (!isFullscreen) return;
    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyPaddingRight = document.body.style.paddingRight;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const scrollbarWidth =
      window.innerWidth - document.documentElement.clientWidth;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsFullscreen(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    document.body.classList.add("editor-fullscreen-active");

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

  const editorInstance = useEditor({
    extensions: createTiptapExtensions(placeholder),
    content,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
    editorProps: {
      attributes: {
        class:
          "max-w-none p-4 min-h-[200px] focus-visible:outline-none text-sm",
      },
    },
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
  });

  useEffect(() => {
    if (editorInstance && content !== editorInstance.getHTML() && isMounted) {
      editorInstance.commands.setContent(content, { emitUpdate: false });
    }
  }, [content, editorInstance, isMounted]);

  if (!isMounted) {
    return (
      <div className={cn("border rounded-md", className)}>
        <div className="border border-input rounded-t-md p-1 bg-background h-10"></div>
        <div className="max-w-none p-4 min-h-[200px] focus-visible:outline-none text-sm border-t">
          <div className="text-muted-foreground">{placeholder}</div>
        </div>
      </div>
    );
  }

  const editorContent = (
    <div
      ref={contentWrapperRef}
      className={cn(
        "flex flex-col bg-background transition-colors",
        isFullscreen
          ? "fixed inset-0 z-[9999] h-dvh w-screen"
          : "border rounded-md",
        !isFullscreen && className,
      )}
    >
      {/* Fullscreen header */}
      {isFullscreen && (
        <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
          <span className="text-sm font-medium text-muted-foreground">
            Editing Content
          </span>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground hidden sm:inline">
              Press <kbd className="px-1.5 py-0.5 rounded border bg-muted text-[10px] font-mono">Esc</kbd> to exit
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsFullscreen(false)}
              className="gap-1.5"
            >
              <Minimize2 className="h-3.5 w-3.5" />
              Exit Fullscreen
            </Button>
          </div>
        </div>
      )}

      {/* Toolbar */}
      {editorInstance && (
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
        />
      )}

      {/* Editor content -- always mounted, never unmounts */}
      <div
        ref={editorAreaRef}
        className={cn(
          "overflow-y-auto border-t",
          isFullscreen ? "flex-1 bg-muted/30" : "",
        )}
        style={!isFullscreen ? { maxHeight: "300px" } : undefined}
        onClick={() => {
          // Click-to-focus: when user clicks the editing area background, focus the editor
          if (isFullscreen && editorInstance && !editorInstance.isFocused) {
            editorInstance.commands.focus("end");
          }
        }}
      >
        <div className={cn(
          isFullscreen
            ? "max-w-4xl mx-auto px-8 py-6 min-h-full bg-background shadow-sm border-x border-border/40"
            : ""
        )}>
          <EditorContent editor={editorInstance} className="max-w-none" />
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
