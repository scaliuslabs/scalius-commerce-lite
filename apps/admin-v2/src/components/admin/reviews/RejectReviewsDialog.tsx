import { useEffect, useId, useState } from "react";
import { REVIEW_REJECTION_REASONS, type ReviewRejectionReason } from "@scalius/shared/reviews";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Label } from "~/components/ui/label";
import { NativeSelect } from "~/components/ui/native-select";
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
  useEffect(() => {
    if (open) setReason("");
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
            if (reason) onReject(reason);
          }}
        >
          <Label htmlFor={fieldId}>{t("reason")}</Label>
          <NativeSelect
            id={fieldId}
            required
            value={reason}
            placeholder={t("reasonPlaceholder")}
            onValueChange={(value) => setReason(value as ReviewRejectionReason)}
          >
            {REVIEW_REJECTION_REASONS.map((value) => (
              <option key={value} value={value}>{t(`reason.${value}`)}</option>
            ))}
          </NativeSelect>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={loading} onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button type="submit" form={formId} variant="destructive" disabled={!reason} loading={loading}>{t("reject")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
