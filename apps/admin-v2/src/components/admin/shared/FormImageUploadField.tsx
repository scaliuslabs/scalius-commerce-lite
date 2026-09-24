import { Button } from "@/components/ui/button";
import { X, ImageIcon } from "lucide-react";
import { MediaManager } from "../media-manager";
import type { MediaFile } from "../media-manager";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { cn } from "@scalius/shared/utils";
import { useMessages } from "~/i18n";
import { mediaMessages } from "~/i18n/media";

interface FormImageUploadFieldProps {
  value?: MediaFile | null;
  /** Receives the chosen file, or null when it's removed. */
  onChange: (file: MediaFile | null) => void;
  triggerLabel?: string;
  changeTriggerLabel?: string;
  aspectRatio?: "aspect-video" | "aspect-square" | "aspect-[4/3]" | "aspect-[3/2]";
  maxWidth?: string;
  placeholder?: string;
  className?: string;
}

/** Single-image field for a react-hook-form FormField: preview + remove, and the file picker. */
export function FormImageUploadField({
  value,
  onChange,
  triggerLabel,
  changeTriggerLabel,
  aspectRatio = "aspect-video",
  maxWidth = "max-w-sm",
  placeholder,
  className,
}: FormImageUploadFieldProps) {
  const t = useMessages(mediaMessages);
  return (
    <div className={cn("space-y-4", className)}>
      {value ? (
        <div className={cn("relative w-full", aspectRatio, maxWidth)}>
          <img
            src={mediaImageUrl(value.url, 640)}
            alt={value.altText || value.filename}
            className="h-full w-full rounded-md bg-muted object-contain"
            loading="lazy"
            decoding="async"
          />
          <Button
            type="button"
            variant="destructive"
            size="icon"
            className="absolute -right-2 -top-2 h-11 w-11 sm:h-8 sm:w-8"
            onClick={() => onChange(null)}
            aria-label={t("removeImage", { name: value.filename })}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div
          className={cn(
            "flex min-h-28 flex-col items-center justify-center gap-2 rounded-md border border-dashed bg-muted px-4 py-6 text-muted-foreground",
            maxWidth,
          )}
        >
          <ImageIcon className="h-8 w-8" aria-hidden="true" />
          <span className="text-body">{placeholder ?? t("noImage")}</span>
        </div>
      )}
      <MediaManager
        capability="image"
        selectedFiles={value ? [value] : []}
        onSelect={(file) => onChange(file)}
        triggerLabel={value ? changeTriggerLabel ?? t("changeImage") : triggerLabel ?? t("chooseImage")}
      />
    </div>
  );
}
