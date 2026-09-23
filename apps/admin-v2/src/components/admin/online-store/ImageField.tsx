import { useId } from "react";
import { ImageIcon } from "lucide-react";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import { MediaManager } from "~/components/admin/media-manager";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";

/** One image chosen from Files: preview, change, remove. */
export function ImageField({
  label,
  src,
  onChange,
  wide = false,
}: {
  label: string;
  src: string;
  onChange: (image: { src: string; alt: string }) => void;
  wide?: boolean;
}) {
  const t = useMessages(onlineStoreMessages);
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="flex items-center gap-3">
      <div
        className={cn(
          "grid shrink-0 place-items-center overflow-clip rounded-lg border bg-muted",
          wide ? "h-16 w-28" : "size-16",
        )}
      >
        {src ? (
          <img src={mediaImageUrl(src, 320)} alt="" className="max-h-full max-w-full object-contain" />
        ) : (
          <ImageIcon className="size-5 text-muted-foreground" aria-hidden />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p id={labelId} className="text-body font-medium">{label}</p>
        <div className="mt-1 flex flex-wrap gap-2">
          <MediaManager
            capability="image"
            onSelect={(file) => onChange({ src: file.url, alt: file.altText?.trim() || "" })}
            trigger={
              <Button type="button" variant="outline" size="sm">
                {src ? t("changeImage") : t("selectImage")}
              </Button>
            }
          />
          {src ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange({ src: "", alt: "" })}
            >
              {t("remove")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
