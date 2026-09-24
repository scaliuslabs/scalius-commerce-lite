import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { cn } from "@scalius/shared/utils";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import {
  AlignLeft,
  AlignCenter,
  AlignRight,
  Trash2,
  ImageOff,
  PencilLine,
  Check,
  X,
} from "lucide-react";
import { Button } from "../button";
import { Input } from "../input";
import { Label } from "../label";
import { NativeSelect } from "../native-select";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";
import {
  clampRichTextImageWidth,
  normalizeRichTextImageWidthPercent,
  richTextImageWidthPercent,
} from "./resizable-image-sizing";
import { useMessages } from "~/i18n";
import { richTextMessages } from "~/i18n/rich-text";

export function ResizableImageView({
  node,
  updateAttributes,
  selected,
  deleteNode,
}: NodeViewProps) {
  const t = useMessages(richTextMessages);
  const { src, alt, width, textAlign } = node.attrs;
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [resizing, setResizing] = useState(false);
  const [displayWidth, setDisplayWidth] = useState<number | null>(null);
  const [imageError, setImageError] = useState(false);
  const [sizeFocused, setSizeFocused] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [altDraft, setAltDraft] = useState<string>(alt || "");
  const [editingCustomSize, setEditingCustomSize] = useState(false);
  const [customSizeDraft, setCustomSizeDraft] = useState("50");
  const widthRef = useRef<number | null>(null);
  const fieldId = useId();
  const altInputId = `${fieldId}-image-alt`;
  const previewSrc = mediaImageUrl(src, 1200);

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
        const newWidth = clampRichTextImageWidth(startWidth + diff, editorWidth);
        widthRef.current = newWidth;
        setDisplayWidth(newWidth);
      };

      const handlePointerUp = () => {
        setResizing(false);
        if (widthRef.current) {
          const widthPercent = richTextImageWidthPercent(
            widthRef.current,
            editorWidth,
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

  const presetWidths = ["25%", "50%", "75%", "100%"];
  const sizeValue = presetWidths.includes(width)
    ? width
    : width
      ? "custom-current"
      : "auto";
  const controlsVisible =
    selected || sizeFocused || detailsOpen || editingCustomSize;

  const changeSize = (value: string) => {
    if (value === "custom") {
      setCustomSizeDraft(
        width ? String(parseInt(width, 10) || 50) : "50",
      );
      setEditingCustomSize(true);
      return;
    }
    updateAttributes({ width: value === "auto" ? null : value });
  };

  const applyCustomSize = () => {
    const nextWidth = normalizeRichTextImageWidthPercent(customSizeDraft);
    if (nextWidth == null) return;
    updateAttributes({ width: `${nextWidth}%` });
    setCustomSizeDraft(String(nextWidth));
    setEditingCustomSize(false);
  };

  return (
    <NodeViewWrapper
      className={cn("resizable-image-wrapper", `align-${textAlign || "center"}`)}
    >
      <div
        ref={containerRef}
        data-drag-handle
        className={cn("group relative inline-block max-w-full", widthStyle && "w-(--image-width)", alignmentClass)}
        style={{ "--image-width": widthStyle } as CSSProperties}
      >
        {imageError ? (
          <div
            className={cn(
              "flex min-h-20 flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-muted p-4 text-muted-foreground",
              widthStyle ? "w-full" : "w-50",
              selected && "ring-2 ring-ring ring-offset-2",
            )}
          >
            <ImageOff className="size-6" />
            <span className="max-w-full truncate text-center text-body">{t("imageFailed")}</span>
          </div>
        ) : (
          <img
            ref={imgRef}
            src={previewSrc || src}
            alt={alt || ""}
            className={cn(
              "block h-auto max-w-full rounded-lg",
              widthStyle && "w-full",
              selected && "ring-2 ring-ring ring-offset-2",
            )}
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
        {controlsVisible && !resizing && (
          <div
            className="mt-2 inline-flex w-fit max-w-full flex-wrap items-center gap-1 rounded-xl bg-popover p-1 shadow-popover"
            data-image-controls
          >
            <div className="flex items-center" role="group" aria-label={t("imageAlignment")}>
            <button
              type="button"
              onClick={() => updateAttributes({ textAlign: "left" })}
              aria-label={t("alignImageLeft")}
              title={t("alignImageLeft")}
              className={cn(
                "flex h-11 w-11 items-center justify-center rounded-lg hover:bg-accent sm:h-8 sm:w-8",
                textAlign === "left" && "bg-accent",
              )}
            >
              <AlignLeft className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => updateAttributes({ textAlign: "center" })}
              aria-label={t("centerImage")}
              title={t("centerImage")}
              className={cn(
                "flex h-11 w-11 items-center justify-center rounded-lg hover:bg-accent sm:h-8 sm:w-8",
                (textAlign === "center" || !textAlign) && "bg-accent",
              )}
            >
              <AlignCenter className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => updateAttributes({ textAlign: "right" })}
              aria-label={t("alignImageRight")}
              title={t("alignImageRight")}
              className={cn(
                "flex h-11 w-11 items-center justify-center rounded-lg hover:bg-accent sm:h-8 sm:w-8",
                textAlign === "right" && "bg-accent",
              )}
            >
              <AlignRight className="size-4" />
            </button>
            </div>
            {editingCustomSize ? (
              <div
                className="flex items-center gap-1"
                role="group"
                aria-label={t("customWidth")}
              >
                <Input
                    type="number"
                    inputMode="numeric"
                    min={20}
                    max={100}
                    value={customSizeDraft}
                    onChange={(event) => setCustomSizeDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        applyCustomSize();
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setEditingCustomSize(false);
                      }
                    }}
                    aria-label={t("customWidthPercent")}
                    className="w-20"
                    autoFocus
                  />
                <span className="text-body text-muted-foreground">%</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("applyCustomWidth")}
                  onClick={applyCustomSize}
                >
                  <Check className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("cancelCustomWidth")}
                  onClick={() => setEditingCustomSize(false)}
                >
                  <X className="size-4" />
                </Button>
              </div>
            ) : (
              <NativeSelect
                aria-label={t("imageSize")}
                className="w-auto min-w-28"
                value={sizeValue}
                onFocus={() => setSizeFocused(true)}
                onBlur={() => setSizeFocused(false)}
                onValueChange={changeSize}
              >
                <option value="auto">{t("sizeNatural")}</option>
                <option value="25%">25%</option>
                <option value="50%">50%</option>
                <option value="75%">75%</option>
                <option value="100%">{t("sizeFull")}</option>
                {sizeValue === "custom-current" ? (
                  <option value="custom-current" disabled>
                    {t("sizeCustomCurrent", { width })}
                  </option>
                ) : null}
                <option value="custom">{t("sizeCustom")}</option>
              </NativeSelect>
            )}
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
                  aria-label={t("editAlt")}
                  title={t("editAlt")}
                  className="flex h-11 w-11 items-center justify-center rounded-lg hover:bg-accent sm:h-8 sm:w-8"
                >
                  <PencilLine className="size-4" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="z-[10001] w-[calc(100vw-2rem)] max-w-sm space-y-3 p-3">
                <div className="space-y-1.5">
                  <Label htmlFor={altInputId}>{t("altText")}</Label>
                  <Input
                    id={altInputId}
                    value={altDraft}
                    maxLength={512}
                    onChange={(event) => setAltDraft(event.target.value)}
                    placeholder={t("altPlaceholder")}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      updateAttributes({ alt: altDraft.trim() });
                      setDetailsOpen(false);
                    }}
                  />
                  <p className="text-body text-muted-foreground">
                    {t("altHelp")}
                  </p>
                </div>
                <Button
                  type="button"
                  className="w-full"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    updateAttributes({ alt: altDraft.trim() });
                    setDetailsOpen(false);
                  }}
                >
                  {t("apply")}
                </Button>
              </PopoverContent>
            </Popover>
            <div className="h-5 w-px bg-border" />
            <button
              type="button"
              onClick={deleteNode}
              aria-label={t("removeImage")}
              title={t("removeImage")}
              className="flex h-11 w-11 items-center justify-center rounded hover:bg-critical-surface hover:text-destructive sm:h-8 sm:w-8"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
}
