import { useCallback, useEffect, useRef, useState } from "react";
import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { cn } from "@scalius/shared/utils";
import { AlignLeft, AlignCenter, AlignRight, Trash2, ImageOff } from "lucide-react";

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
  const widthRef = useRef<number | null>(null);

  // Reset display width when the attribute changes externally
  useEffect(() => {
    setDisplayWidth(null);
  }, [width]);

  // Reset error state when src changes
  useEffect(() => {
    setImageError(false);
  }, [src]);

  const getStartWidth = useCallback(() => {
    if (imgRef.current && imgRef.current.offsetWidth > 0) {
      return imgRef.current.offsetWidth;
    }
    if (width && typeof width === "string") {
      return parseInt(width, 10) || 300;
    }
    return 300;
  }, [width]);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = getStartWidth();
      setResizing(true);

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const diff = moveEvent.clientX - startX;
        const newWidth = Math.max(80, startWidth + diff);
        widthRef.current = newWidth;
        setDisplayWidth(newWidth);
      };

      const handleMouseUp = () => {
        setResizing(false);
        if (widthRef.current) {
          updateAttributes({ width: `${widthRef.current}px` });
        }
        widthRef.current = null;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [getStartWidth, updateAttributes],
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
            src={src}
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

        {/* Floating toolbar - show when selected, z-[9999] ensures visibility in fullscreen */}
        {selected && !resizing && (
          <div className="absolute -top-10 left-1/2 -translate-x-1/2 flex items-center gap-0.5 bg-background border rounded-md shadow-lg p-0.5 z-[9999]">
            <button
              type="button"
              onClick={() => updateAttributes({ textAlign: "left" })}
              className={cn(
                "p-1.5 rounded hover:bg-accent transition-colors",
                textAlign === "left" && "bg-accent",
              )}
            >
              <AlignLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => updateAttributes({ textAlign: "center" })}
              className={cn(
                "p-1.5 rounded hover:bg-accent transition-colors",
                (textAlign === "center" || !textAlign) && "bg-accent",
              )}
            >
              <AlignCenter className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => updateAttributes({ textAlign: "right" })}
              className={cn(
                "p-1.5 rounded hover:bg-accent transition-colors",
                textAlign === "right" && "bg-accent",
              )}
            >
              <AlignRight className="h-3.5 w-3.5" />
            </button>
            <div className="w-px h-4 bg-border mx-0.5" />
            <button
              type="button"
              onClick={deleteNode}
              className="p-1.5 rounded hover:bg-destructive/10 hover:text-destructive transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Resize handle - right edge */}
        {selected && (
          <div
            className="resize-handle right opacity-0 group-hover:opacity-100 transition-opacity"
            onMouseDown={handleResizeStart}
          />
        )}

        {/* Resize handle - bottom-right corner */}
        {selected && (
          <div
            className="resize-handle bottom-right opacity-0 group-hover:opacity-100 transition-opacity"
            onMouseDown={handleResizeStart}
          />
        )}
      </div>
    </NodeViewWrapper>
  );
}
