import { useEffect, useId, useState } from "react";
import { REVIEW_REJECTION_REASONS, type ReviewRejectionReason } from "@scalius/shared/reviews";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Label } from "~/components/ui/label";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useMessages } from "~/i18n";
import { reviewsMessages } from "~/i18n/reviews";

/**
 * Asks why before rejecting: a content reason is required (spam, abuse,
 * personal information, off topic, not about the product). There is no
 * "low rating" reason, by design.
 */
export function RejectReviewsDialog({
  open,
  count,
  loading,
  onOpenChange,
  onReject,
}: {
  open: boolean;
  count: number;
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  onReject: (reason: ReviewRejectionReason) => void;
}) {
  const t = useMessages(reviewsMessages);
  const fieldId = useId();
  const formId = useId();
  const [reason, setReason] = useState<ReviewRejectionReason | "">("");
  const [missingReason, setMissingReason] = useState(false);
  useEffect(() => {
    if (open) {
      setReason("");
      setMissingReason(false);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => !loading && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{count === 1 ? t("rejectOneTitle") : t("rejectTitle", { count })}</DialogTitle>
          <DialogDescription>{t("rejectBody")}</DialogDescription>
        </DialogHeader>
        <form method="post"
          id={formId}
          className="flex flex-col gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (loading) return;
            if (!reason) {
              setMissingReason(true);
              document.getElementById(fieldId)?.focus();
              return;
            }
            onReject(reason);
          }}
        >
          <Label htmlFor={fieldId}>{t("reason")}</Label>
          <SearchableSelect
            id={fieldId}
            required
            value={reason}
            aria-invalid={missingReason}
            aria-describedby={missingReason ? `${fieldId}-error` : undefined}
            placeholder={t("reasonPlaceholder")}
            onValueChange={(value) => {
              setReason(value as ReviewRejectionReason);
              setMissingReason(false);
            }}
            triggerClassName="w-full"
            options={REVIEW_REJECTION_REASONS.map((value) => ({ value, label: t(`reason.${value}`) }))}
          />
          {missingReason ? <p id={`${fieldId}-error`} role="alert" className="text-body text-destructive">{t("reasonPlaceholder")}</p> : null}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={loading} onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button type="submit" form={formId} variant="destructive" disabled={!reason} loading={loading}>{t("reject")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
