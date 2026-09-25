import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { toast } from "sonner";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { REVIEW_LIMITS } from "@scalius/shared/reviews";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import { Skeleton } from "~/components/ui/skeleton";
import { Textarea } from "~/components/ui/textarea";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { reviewsMessages } from "~/i18n/reviews";
import { getServerFnError } from "~/lib/api-helpers";
import { reviewQueryOptions, type AdminReview } from "~/lib/api-query-options/reviews";
import { formatOrderDate, formatOrderTimestamp } from "../orderview/formatters";
import { CheckFlagChips, ProductThumb, ReviewStars, ReviewStatusBadge } from "./review-parts";
import { isConflict, useOpenReviewThread, useSaveReply, type ModerationAction } from "./reviews-api";

/**
 * One review beside the list (Judge.me's review panel): the buyer's full
 * words, where it came from, what staff can do with it, the store's public
 * reply and when things happened. Staff can't change the rating or text.
 */
export function ReviewSheet({
  reviewId,
  initial,
  moderating,
  onModerate,
  onClose,
}: {
  reviewId: string | null;
  /** The list's copy, shown while the fresh one loads. */
  initial: AdminReview | undefined;
  moderating: boolean;
  onModerate: (review: AdminReview, action: ModerationAction) => void;
  onClose: () => void;
}) {
  const t = useMessages(reviewsMessages);
  const detail = useQuery({ ...reviewQueryOptions(reviewId ?? ""), enabled: reviewId !== null });
  const current = reviewId ? (detail.data ?? (initial?.id === reviewId ? initial : undefined)) : undefined;
  // Keep the last review on screen while the sheet slides closed.
  const [shown, setShown] = useState<AdminReview | undefined>(current);
  useEffect(() => {
    if (current) setShown(current);
  }, [current]);
  const review = current ?? shown;

  return (
    <Sheet open={reviewId !== null} onOpenChange={(next) => !next && onClose()}>
      <SheetContent className="flex flex-col sm:max-w-lg">
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
          <div className="flex items-start gap-2 p-6 pb-4">
            <SheetHeader className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <SheetTitle>{t("review")}</SheetTitle>
                {review ? <ReviewStatusBadge status={review.status} /> : null}
              </div>
              <SheetDescription>
                {review ? t("byline", { name: review.authorName, date: formatOrderDate(review.createdAt) ?? "" }) : " "}
              </SheetDescription>
            </SheetHeader>
            <SheetClose asChild>
              <Button variant="ghost" size="icon" className="-mr-2 -mt-2 shrink-0" aria-label={t("close")}>
                <X className="size-4" />
              </Button>
            </SheetClose>
          </div>
          {review ? (
            <ReviewDetail key={review.id} review={review} />
          ) : detail.isError ? (
            <div className="flex flex-col items-start gap-2 px-6">
              <p className="text-body text-destructive">{t("loadFailed")}</p>
              <Button type="button" size="sm" variant="outline" onClick={() => void detail.refetch()}>{t("retry")}</Button>
            </div>
          ) : (
            <div aria-busy className="flex flex-col gap-3 px-6">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}
        </div>
        {review ? <ReviewActions review={review} moderating={moderating} onModerate={onModerate} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function ReviewDetail({ review }: { review: AdminReview }) {
  const t = useMessages(reviewsMessages);
  const canModerate = useHasPermission(PERMISSIONS.REVIEWS_MODERATE);
  const moderationReason = review.moderationReason;
  const history: Array<[string, string | null]> = [
    [t("submitted"), review.createdAt],
    [t("publishedAt"), review.publishedAt],
    [t("edited"), review.editedAt],
    [t("replied"), review.reply?.repliedAt ?? null],
  ];

  return (
    <div className="flex flex-col divide-y">
      <section className="flex flex-col gap-2 px-6 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <ReviewStars rating={review.rating} />
          <Badge variant="success">{t("verified")}</Badge>
        </div>
        {review.title ? <h3 className="break-words text-heading-sm">{review.title}</h3> : null}
        {review.body ? (
          <p className="whitespace-pre-line break-words">{review.body}</p>
        ) : !review.title ? (
          <p className="text-body text-muted-foreground">{t("noText")}</p>
        ) : null}
        {review.status === "pending" ? <CheckFlagChips flags={review.checkFlags} /> : null}
        {review.status === "rejected" && moderationReason ? (
          <p className="text-body text-muted-foreground">{t("rejectedFor", { reason: t(`reason.${moderationReason}`) })}</p>
        ) : null}
        {review.status === "withdrawn" ? <p className="text-body text-muted-foreground">{t("withdrawnNote")}</p> : null}
      </section>

      <section className="flex flex-col gap-3 p-6 py-4">
        <div className="flex items-start gap-3">
          <ProductThumb imageUrl={review.product.imageUrl} />
          <div className="flex min-w-0 flex-col gap-1">
            <Link to="/admin/products/$productId/edit" params={{ productId: review.product.id }} className="break-words text-link hover:underline">
              {review.product.name}
            </Link>
            {review.variantLabel ? <span className="text-body text-muted-foreground">{review.variantLabel}</span> : null}
            <Link to="/admin/reviews" search={{ productId: review.product.id }} className="text-body text-link hover:underline">
              {t("productReviews")}
            </Link>
          </div>
        </div>
        <p className="text-body">
          {t("order")}{" "}
          <Link to="/admin/orders/$orderId" params={{ orderId: review.order.id }} className="text-link hover:underline">
            <code>{review.order.orderNumber}</code>
          </Link>
        </p>
      </section>

      {canModerate ? (
        <ReplyEditor review={review} />
      ) : review.reply ? (
        <section className="flex flex-col gap-1 p-6 py-4">
          <h3 className="text-heading-sm">{t("reply")}</h3>
          <p className="whitespace-pre-line break-words">{review.reply.body}</p>
        </section>
      ) : null}

      <section className="flex flex-col gap-2 p-6 py-4">
        <h3 className="text-heading-sm">{t("history")}</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          {history.map(([label, at]) =>
            at ? (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="tabular-nums">{formatOrderTimestamp(at)}</dd>
              </div>
            ) : null,
          )}
        </dl>
      </section>
    </div>
  );
}

function ReplyEditor({ review }: { review: AdminReview }) {
  const t = useMessages(reviewsMessages);
  const fieldId = useId();
  const [body, setBody] = useState(review.reply?.body ?? "");
  const [conflict, setConflict] = useState(false);
  const save = useSaveReply(review.id);
  const trimmed = body.trim();
  const tooLong = Array.from(trimmed).length > REVIEW_LIMITS.replyLength;
  const unchanged = trimmed === (review.reply?.body ?? "");

  const submit = (next: string | null) => {
    setConflict(false);
    save.mutate(
      { body: next, version: review.version },
      {
        onSuccess: (saved) => {
          setBody(saved.reply?.body ?? "");
          toast.success(t(next === null ? "replyRemoved" : "replySaved"));
        },
        onError: (error) => {
          if (isConflict(error)) setConflict(true);
          else toast.error(getServerFnError(error, t("actionFailed")));
        },
      },
    );
  };

  return (
    <section className="flex flex-col gap-2 p-6 py-4">
      <h3 className="text-heading-sm">
        <label htmlFor={fieldId}>{t("reply")}</label>
      </h3>
      {conflict ? (
        <Alert variant="warning">
          <AlertDescription>{t("conflict")}</AlertDescription>
        </Alert>
      ) : null}
      <Textarea
        id={fieldId}
        rows={4}
        value={body}
        placeholder={t("replyPlaceholder")}
        aria-invalid={tooLong || undefined}
        aria-describedby={`${fieldId}-help`}
        onChange={(event) => setBody(event.target.value)}
      />
      <p id={`${fieldId}-help`} className={tooLong ? "text-body text-destructive" : "text-body text-muted-foreground"}>
        {tooLong ? t("replyTooLong", { max: REVIEW_LIMITS.replyLength }) : t("replyHelp")}
      </p>
      {review.reply?.authorName ? <p className="text-body text-muted-foreground">{t("replyBy", { name: review.reply.authorName })}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!trimmed || tooLong || unchanged}
          loading={save.isPending && save.variables?.body !== null}
          onClick={() => submit(trimmed)}
        >
          {t("saveReply")}
        </Button>
        {review.reply ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={save.isPending}
            loading={save.isPending && save.variables?.body === null}
            onClick={() => submit(null)}
          >
            {t("removeReply")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function ReviewActions({
  review,
  moderating,
  onModerate,
}: {
  review: AdminReview;
  moderating: boolean;
  onModerate: (review: AdminReview, action: ModerationAction) => void;
}) {
  const t = useMessages(reviewsMessages);
  const navigate = useNavigate();
  const canModerate = useHasPermission(PERMISSIONS.REVIEWS_MODERATE);
  const canMessage = useHasPermission(PERMISSIONS.CONVERSATIONS_REPLY) && canModerate;
  const thread = useOpenReviewThread();
  if (!canModerate) return null;

  const messageReviewer = () =>
    thread.mutate(review.id, {
      onSuccess: (conversationId) => void navigate({ to: "/admin/inbox/$conversationId", params: { conversationId } }),
      onError: (error) => toast.error(getServerFnError(error, t("messageFailed"))),
    });

  return (
    <SheetFooter>
      {canMessage ? (
        <Button type="button" variant="outline" loading={thread.isPending} onClick={messageReviewer} className="sm:mr-auto">
          {t("messageReviewer")}
        </Button>
      ) : null}
      {review.status === "pending" || review.status === "published" ? (
        <Button type="button" variant="outline" disabled={moderating} onClick={() => onModerate(review, "reject")}>
          {t("reject")}
        </Button>
      ) : null}
      {review.status === "pending" ? (
        <Button type="button" loading={moderating} onClick={() => onModerate(review, "publish")}>
          {t("publish")}
        </Button>
      ) : null}
      {review.status === "rejected" ? (
        <Button type="button" loading={moderating} onClick={() => onModerate(review, "restore")}>
          {t("restore")}
        </Button>
      ) : null}
    </SheetFooter>
  );
}
