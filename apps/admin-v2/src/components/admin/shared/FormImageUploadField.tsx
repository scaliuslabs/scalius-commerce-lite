import { Button } from "@/components/ui/button";
import { X, ImageIcon } from "lucide-react";
import { MediaManager } from "../media-manager";
import type { MediaFile } from "../media-manager";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { cn } from "@scalius/shared/utils";

interface FormImageUploadFieldProps {
  /** Current image value (MediaFile object or null) */
  value?: MediaFile | null;
  /** Called when image changes — receives MediaFile on select, null on remove */
  onChange: (file: MediaFile | null) => void;
  /** Label for the MediaManager trigger button when no image is set */
  triggerLabel?: string;
  /** Label for the MediaManager trigger button when an image is already set */
  changeTriggerLabel?: string;
  /** Aspect ratio class for the preview container */
  aspectRatio?: "aspect-video" | "aspect-square" | "aspect-[4/3]" | "aspect-[3/2]";
  /** Max width class for the preview container */
  maxWidth?: string;
  /** Placeholder text when no image is set */
  placeholder?: string;
  /** Additional className for the outer wrapper */
  className?: string;
}

/**
 * Shared single-image upload field for use inside react-hook-form FormField render props.
 *
 * Shows a preview when an image is selected (with a remove button),
 * and a MediaManager dialog trigger to select/change the image.
 *
 * Usage with FormField:
 * ```tsx
 * <FormField
 *   control={form.control}
 *   name="image"
 *   render={({ field }) => (
 *     <FormItem>
 *       <FormImageUploadField
 *         value={field.value}
 *         onChange={field.onChange}
 *       />
 *       <FormMessage />
 *     </FormItem>
 *   )}
 * />
 * ```
 */
export function FormImageUploadField({
  value,
  onChange,
  triggerLabel = "Select Image",
  changeTriggerLabel = "Change Image",
  aspectRatio = "aspect-video",
  maxWidth = "max-w-sm",
  placeholder = "No image selected",
  className,
}: FormImageUploadFieldProps) {
  return (
    <div className={cn("space-y-4", className)}>
      {value ? (
        <div className={cn("relative w-full", aspectRatio, maxWidth)}>
          <img
            src={getOptimizedImageUrl(value.url)}
            alt={value.filename}
            className="h-full w-full rounded-md object-cover"
            loading="lazy"
            decoding="async"
          />
          <Button
            type="button"
            variant="destructive"
            size="icon"
            className="absolute -right-2 -top-2 h-6 w-6"
            onClick={() => onChange(null)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div
          className={cn(
            "flex flex-col items-center justify-center rounded-md border border-dashed border-muted-foreground/30 bg-muted/20 text-muted-foreground",
            aspectRatio,
            maxWidth,
          )}
        >
          <ImageIcon className="h-8 w-8 mb-2 opacity-40" />
          <span className="text-xs">{placeholder}</span>
        </div>
      )}
      <MediaManager
        selectedFiles={value ? [value] : []}
        onSelect={(file) => onChange(file)}
        triggerLabel={value ? changeTriggerLabel : triggerLabel}
      />
    </div>
  );
}
