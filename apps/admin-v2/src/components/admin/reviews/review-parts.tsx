// Small pieces the Reviews page, its sheet and the inbox Review card share.
import { ImageIcon, Star } from "lucide-react";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { cn } from "@scalius/shared/utils";
import { Badge, type BadgeVariant } from "~/components/ui/badge";
import { useMessages } from "~/i18n";
import { reviewsMessages } from "~/i18n/reviews";

/** Five stars, the first `rating` filled; read as "4 out of 5 stars". */
export function ReviewStars({ rating, className }: { rating: number; className?: string }) {
  const t = useMessages(reviewsMessages);
  return (
    <span role="img" aria-label={t("stars", { rating })} className={cn("inline-flex shrink-0 items-center gap-0.5", className)}>
      {[1, 2, 3, 4, 5].map((value) => (
        <Star
          key={value}
          aria-hidden
          className={value <= rating ? "size-4 fill-current text-caution" : "size-4 text-muted-foreground"}
        />
      ))}
    </span>
  );
}

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  pending: "attention",
  published: "success",
  rejected: "secondary",
  withdrawn: "secondary",
};

export function ReviewStatusBadge({ status }: { status: string }) {
  const t = useMessages(reviewsMessages);
  const known = status === "pending" || status === "published" || status === "rejected" || status === "withdrawn";
  return <Badge variant={STATUS_VARIANT[status] ?? "secondary"}>{known ? t(`status.${status}`) : status}</Badge>;
}

/** "Link", "Email"… for the automatic checks that held a review. */
export function CheckFlagChips({ flags }: { flags: readonly string[] }) {
  const t = useMessages(reviewsMessages);
  const known = flags.filter(
    (flag): flag is "url" | "email" | "phone" | "repeated_characters" | "block_word" =>
      flag === "url" || flag === "email" || flag === "phone" || flag === "repeated_characters" || flag === "block_word",
  );
  if (known.length === 0) return null;
  return (
    // Phrasing content only: it also sits inside a list row's button.
    <span className="flex flex-wrap items-center gap-1.5">
      <span className="text-body text-muted-foreground">{t("flagsLabel")}</span>
      {known.map((flag) => (
        <Badge key={flag} variant="warning">{t(`flag.${flag}`)}</Badge>
      ))}
    </span>
  );
}

export function ProductThumb({ imageUrl }: { imageUrl: string | null }) {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
      {imageUrl ? (
        <img src={mediaImageUrl(imageUrl, 160)} alt="" className="size-full object-contain" loading="lazy" decoding="async" />
      ) : (
        <ImageIcon className="size-4 text-muted-foreground" aria-hidden="true" />
      )}
    </span>
  );
}
