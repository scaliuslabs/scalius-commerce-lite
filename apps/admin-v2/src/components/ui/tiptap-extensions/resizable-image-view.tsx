import { useCallback, useEffect, useId, useRef, useState } from "react";
import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { cn } from "@scalius/shared/utils";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import {
  AlignLeft,
  AlignCenter,
  AlignRight,
  Trash2,
  ImageOff,
  PencilLine,
} from "lucide-react";
import { Button } from "../button";
import { Input } from "../input";
import { Label } from "../label";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";

export function ResizableImageView({
  node,
  updateAttributes,
  selected,
  deleteNode,
}: NodeViewProps) {
  const { src, alt, width, textAlign } = node.attrs;
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [resizing, setResizing] = useState(false);
  const [displayWidth, setDisplayWidth] = useState<number | null>(null);
  const [imageError, setImageError] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [altDraft, setAltDraft] = useState<string>(alt || "");
  const widthRef = useRef<number | null>(null);
  const fieldId = useId();
  const altInputId = `${fieldId}-image-alt`;
  const previewSrc = getOptimizedImageUrl(src, {
    width: 1200,
    height: null,
    quality: 85,
    fit: "scale-down",
  });

  // Reset display width when the attribute changes externally
  useEffect(() => {
    setDisplayWidth(null);
  }, [width]);

  // Reset error state when src changes
  useEffect(() => {
    setImageError(false);
  }, [src]);

  useEffect(() => {
    setAltDraft(alt || "");
  }, [alt]);

  const getStartWidth = useCallback(() => {
    if (imgRef.current && imgRef.current.offsetWidth > 0) {
      return imgRef.current.offsetWidth;
    }
    if (width && typeof width === "string") {
      return parseInt(width, 10) || 300;
    }
    return 300;
  }, [width]);

  const getEditorWidth = useCallback(() => {
    const editor = containerRef.current?.closest<HTMLElement>(".ProseMirror");
    return Math.max(1, editor?.clientWidth ?? containerRef.current?.parentElement?.clientWidth ?? 1);
  }, []);

  const handleResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = getStartWidth();
      const editorWidth = getEditorWidth();
      setResizing(true);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const diff = moveEvent.clientX - startX;
        const newWidth = Math.min(editorWidth, Math.max(80, startWidth + diff));
        widthRef.current = newWidth;
        setDisplayWidth(newWidth);
      };

      const handlePointerUp = () => {
        setResizing(false);
        if (widthRef.current) {
          const widthPercent = Math.max(
            20,
            Math.min(100, Math.round((widthRef.current / editorWidth) * 100)),
          );
          updateAttributes({ width: `${widthPercent}%` });
        }
        widthRef.current = null;
        document.removeEventListener("pointermove", handlePointerMove);
        document.removeEventListener("pointerup", handlePointerUp);
        document.removeEventListener("pointercancel", handlePointerUp);
      };

      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", handlePointerUp);
      document.addEventListener("pointercancel", handlePointerUp);
    },
    [getEditorWidth, getStartWidth, updateAttributes],
  );

  // Compute the width style for the container
  const widthStyle = displayWidth != null
    ? `${displayWidth}px`
    : width || undefined;

  const alignmentClass =
    textAlign === "center"
      ? "mx-auto"
      : textAlign === "right"
        ? "ml-auto"
        : "mr-auto";

  return (
    <NodeViewWrapper
      className={cn("resizable-image-wrapper", `align-${textAlign || "center"}`)}
      data-drag-handle
    >
      <div
        ref={containerRef}
        className={cn("relative inline-block group", alignmentClass)}
        style={{ width: widthStyle, maxWidth: "100%" }}
      >
        {imageError ? (
          <div
            className={cn(
              "flex flex-col items-center justify-center gap-2 rounded-md bg-muted/50 border border-dashed border-border text-muted-foreground p-4",
              selected && "ring-2 ring-primary ring-offset-2",
            )}
            style={{
              width: widthStyle ? "100%" : "200px",
              minHeight: "80px",
            }}
          >
            <ImageOff className="h-6 w-6" />
            <span className="text-xs text-center truncate max-w-full">Image failed to load</span>
          </div>
        ) : (
          <img
            ref={imgRef}
            src={previewSrc || src}
            alt={alt || ""}
            className={cn(
              "block h-auto rounded-md",
              selected && "ring-2 ring-primary ring-offset-2",
            )}
            style={{
              width: widthStyle ? "100%" : undefined,
              maxWidth: "100%",
            }}
            draggable={false}
            onError={() => setImageError(true)}
          />
        )}

        {/* Pointer resize handles supplement the accessible size presets below. */}
        {selected && (
          <div
            className="resize-handle right hidden sm:block"
            onPointerDown={handleResizeStart}
            aria-hidden="true"
          />
        )}

        {selected && (
          <div
            className="resize-handle bottom-right hidden sm:block"
            onPointerDown={handleResizeStart}
            aria-hidden="true"
          />
        )}
      </div>

      <div className="leading-normal">
        {selected && !resizing && (
          <div className="mt-2 flex max-w-full flex-wrap items-center gap-1 rounded-md border bg-background p-1 shadow-sm">
            <div className="flex items-center" role="group" aria-label="Image alignment">
            <button
              type="button"
              onClick={() => updateAttributes({ textAlign: "left" })}
              aria-label="Align image left"
              title="Align image left"
              className={cn(
                "flex h-11 w-11 items-center justify-center rounded transition-colors hover:bg-accent sm:h-8 sm:w-8",
                textAlign === "left" && "bg-accent",
              )}
            >
              <AlignLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => updateAttributes({ textAlign: "center" })}
              aria-label="Center image"
              title="Center image"
              className={cn(
                "flex h-11 w-11 items-center justify-center rounded transition-colors hover:bg-accent sm:h-8 sm:w-8",
                (textAlign === "center" || !textAlign) && "bg-accent",
              )}
            >
              <AlignCenter className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => updateAttributes({ textAlign: "right" })}
              aria-label="Align image right"
              title="Align image right"
              className={cn(
                "flex h-11 w-11 items-center justify-center rounded transition-colors hover:bg-accent sm:h-8 sm:w-8",
                textAlign === "right" && "bg-accent",
              )}
            >
              <AlignRight className="h-3.5 w-3.5" />
            </button>
            </div>
            <select
              aria-label="Image size"
              value={
                ["25%", "50%", "75%", "100%"].includes(width)
                  ? width
                  : width
                    ? "custom"
                    : "auto"
              }
              onChange={(event) =>
                updateAttributes({
                  width: event.target.value === "auto" ? null : event.target.value,
                })
              }
              className="h-11 rounded-md border border-input bg-background px-2 text-xs sm:h-8"
            >
              <option value="auto">Natural</option>
              <option value="25%">25%</option>
              <option value="50%">50%</option>
              <option value="75%">75%</option>
              <option value="100%">Full width</option>
              <option value="custom" disabled>Custom</option>
            </select>
            <Popover
              open={detailsOpen}
              onOpenChange={(open) => {
                setDetailsOpen(open);
                if (open) setAltDraft(alt || "");
              }}
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="Edit image alternative text"
                  title="Edit image alternative text"
                  className="flex h-11 w-11 items-center justify-center rounded transition-colors hover:bg-accent sm:h-8 sm:w-8"
                >
                  <PencilLine className="h-3.5 w-3.5" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="z-[10001] w-[calc(100vw-2rem)] max-w-sm space-y-3 p-3">
                <div className="space-y-1.5">
                  <Label htmlFor={altInputId} className="text-xs">
                    Alternative text
                  </Label>
                  <Input
                    id={altInputId}
                    value={altDraft}
                    maxLength={512}
                    onChange={(event) => setAltDraft(event.target.value)}
                    placeholder="Describe the image"
                    className="min-h-11 sm:min-h-9"
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      updateAttributes({ alt: altDraft.trim() });
                      setDetailsOpen(false);
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave empty only when the image is decorative.
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  className="min-h-11 w-full sm:min-h-9"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    updateAttributes({ alt: altDraft.trim() });
                    setDetailsOpen(false);
                  }}
                >
                  Apply
                </Button>
              </PopoverContent>
            </Popover>
            <div className="h-5 w-px bg-border" />
            <button
              type="button"
              onClick={deleteNode}
              aria-label="Remove image"
              title="Remove image"
              className="flex h-11 w-11 items-center justify-center rounded transition-colors hover:bg-destructive/10 hover:text-destructive sm:h-8 sm:w-8"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
}
