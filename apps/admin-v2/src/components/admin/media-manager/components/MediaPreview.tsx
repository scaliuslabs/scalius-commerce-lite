// Media preview dialog component

import { useState, useEffect, useRef } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Dialog, DialogContent, DialogFooter } from "~/components/ui/dialog";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import type { MediaFile } from "../types";
import { formatFileSize, formatDate, formatFileType } from "../utils";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";

interface MediaPreviewProps {
  open: boolean;
  file: MediaFile | null;
  files: MediaFile[];
  onOpenChange: (open: boolean) => void;
  onNavigateNext: () => void;
  onNavigatePrev: () => void;
  onSelect?: (file: MediaFile) => void;
  onAltTextUpdate?: (fileId: string, altText: string) => Promise<void>;
}

export function MediaPreview({
  open,
  file,
  files,
  onOpenChange,
  onNavigateNext,
  onNavigatePrev,
  onSelect,
  onAltTextUpdate,
}: MediaPreviewProps) {
  const [altTextValue, setAltTextValue] = useState("");
  const [isSavingAlt, setIsSavingAlt] = useState(false);
  const lastSavedAltRef = useRef("");

  // Sync alt text when file changes
  useEffect(() => {
    const val = file?.altText ?? "";
    setAltTextValue(val);
    lastSavedAltRef.current = val;
  }, [file?.id, file?.altText]);

  const saveAltText = async () => {
    if (!file || !onAltTextUpdate) return;
    const trimmed = altTextValue.trim();
    if (trimmed === lastSavedAltRef.current) return;
    setIsSavingAlt(true);
    try {
      await onAltTextUpdate(file.id, trimmed);
      lastSavedAltRef.current = trimmed;
    } finally {
      setIsSavingAlt(false);
    }
  };

  if (!file) return null;

  const currentIndex = files.findIndex((f) => f.id === file.id);
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === files.length - 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] h-[90vh] flex flex-col p-0 overflow-hidden">
        {/* Header */}
        <div className="flex items-center p-4 border-b">
          <div className="flex-1 overflow-hidden">
            <h3 className="text-lg font-semibold truncate">{file.filename}</h3>
            <div className="flex gap-4 text-sm text-muted-foreground flex-wrap">
              <span>{formatFileSize(file.size)}</span>
              {file.mimeType && <span>{formatFileType(file.mimeType)}</span>}
              {file.width && file.height && (
                <span>{file.width} x {file.height}</span>
              )}
              <span>{formatDate(file.createdAt)}</span>
            </div>
          </div>
          <div className="text-sm text-muted-foreground ml-4">
            {currentIndex + 1} / {files.length}
          </div>
        </div>

        {/* Image preview area */}
        <div className="relative flex-1 bg-black/10 dark:bg-black/30 flex items-center justify-center overflow-hidden">
          <img
            src={getOptimizedImageUrl(file.url)}
            alt={file.altText || file.filename}
            className="max-w-full max-h-[calc(90vh-13rem)] object-contain"
            loading="lazy"
            decoding="async"
          />

          {/* Navigation buttons */}
          <Button
            variant="ghost"
            size="icon"
            className="absolute left-4 top-1/2 -translate-y-1/2 bg-background/80 backdrop-blur-sm hover:bg-background rounded-full h-10 w-10"
            onClick={onNavigatePrev}
            disabled={isFirst}
          >
            <ChevronLeft className="h-6 w-6" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="absolute right-4 top-1/2 -translate-y-1/2 bg-background/80 backdrop-blur-sm hover:bg-background rounded-full h-10 w-10"
            onClick={onNavigateNext}
            disabled={isLast}
          >
            <ChevronRight className="h-6 w-6" />
          </Button>
        </div>

        {/* Alt text editing */}
        {onAltTextUpdate && (
          <div className="px-4 py-2 border-t bg-muted/20">
            <div className="flex items-center gap-2">
              <label htmlFor="preview-alt-text" className="text-xs font-medium text-muted-foreground shrink-0">
                Alt text
              </label>
              <Input
                id="preview-alt-text"
                type="text"
                value={altTextValue}
                onChange={(e) => setAltTextValue(e.target.value)}
                onBlur={saveAltText}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveAltText();
                  }
                }}
                placeholder="Describe this image for accessibility..."
                className="h-7 text-sm flex-1"
                disabled={isSavingAlt}
              />
              {isSavingAlt && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />}
            </div>
          </div>
        )}

        {/* Footer */}
        <DialogFooter className="p-4 border-t">
          <div className="flex w-full justify-between">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>

            {onSelect && (
              <Button
                variant="default"
                onClick={() => {
                  onSelect(file);
                  onOpenChange(false);
                }}
              >
                Select This Image
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
