import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { Check, Copy, TriangleAlert } from "lucide-react";
import { GIFT_CARD_LIMITS } from "@scalius/core/modules/gift-cards/browser";
import { MoneyInput } from "~/components/admin/shared/MoneyInput";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import { Textarea } from "~/components/ui/textarea";
import { useCurrency } from "~/hooks/use-currency";
import { useMessages } from "~/i18n";
import { giftCardsMessages } from "~/i18n/gift-cards";
import { getServerFnError } from "~/lib/api-helpers";
import { GiftCardCustomerPicker } from "./GiftCardCustomerPicker";
import { fieldDescribedBy, GiftCardCheckRow, GiftCardField } from "./gift-card-fields";
import { EMPTY_ISSUE_DRAFT, issueRequestBody, validateIssueDraft, type IssueDraft, type IssueErrors } from "./gift-card-drafts";
import { maskedGiftCard, todayStoreDay } from "./gift-card-format";
import { useIssueGiftCard } from "./use-gift-card-mutations";

/**
 * Shopify's "Issue gift card". One request key per opening makes a double
 * click or a retry return the same card. The code comes back once: it is
 * shown from the mutation result only (never a query, the URL or a log) and
 * dropped when the dialog closes.
 */
export function IssueGiftCardDialog({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useMessages(giftCardsMessages);
  const { code: currencyCode } = useCurrency();
  const [draft, setDraft] = useState<IssueDraft>(EMPTY_ISSUE_DRAFT);
  const [errors, setErrors] = useState<IssueErrors>({});
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const requestKey = useRef("");
  const mutation = useIssueGiftCard();
  const issued = mutation.data;
  const reset = mutation.reset;

  useEffect(() => {
    if (open) {
      setDraft(EMPTY_ISSUE_DRAFT);
      setErrors({});
      setCopied("idle");
      requestKey.current = crypto.randomUUID();
      return;
    }
    // Closing forgets the code.
    reset();
  }, [open, reset]);

  const update = (patch: Partial<IssueDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setErrors((current) => {
      const next = { ...current };
      if ("amount" in patch) delete next.amount;
      if ("hasExpiry" in patch || "expiryDay" in patch) delete next.expiry;
      if ("contact" in patch || "deliverBy" in patch) delete next.contact;
      if ("notify" in patch || "contact" in patch || "customer" in patch) delete next.notify;
      return next;
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutation.isPending) return;
    const next = validateIssueDraft(draft, currencyCode);
    setErrors(next);
    const first = (["amount", "expiry", "contact", "notify"] as const).find((field) => next[field]);
    if (first) {
      document.getElementById(`gift-card-${first}`)?.focus();
      return;
    }
    mutation.mutate(issueRequestBody(draft, requestKey.current));
  };

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };

  const error = (field: keyof IssueErrors) => {
    const key = errors[field];
    return key ? t(key) : undefined;
  };
  const busy = mutation.isPending;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        // With the code on screen, only Done or Esc closes: a stray click must not lose it.
        onInteractOutside={(event) => { if (issued) event.preventDefault(); }}
      >
        {issued ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("codeTitle")}</DialogTitle>
              <DialogDescription>{maskedGiftCard(issued.giftCard.last4)}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <p id="gift-card-code-label" className="text-body font-medium">{t("codeLabel")}</p>
                <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted px-3 py-2">
                  <output aria-labelledby="gift-card-code-label" className="min-w-0 flex-1 select-all break-all font-mono text-heading-md">
                    {issued.code}
                  </output>
                  <Button type="button" variant="outline" size="sm" onClick={() => void copy(issued.code)}>
                    {copied === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
                    {copied === "copied" ? t("copied") : t("copyCode")}
                  </Button>
                </div>
                {copied === "failed" ? <p className="text-body text-destructive">{t("copyFailed")}</p> : null}
              </div>
              <Alert variant="warning">
                <TriangleAlert aria-hidden />
                <AlertDescription>{t("codeWarning")}</AlertDescription>
              </Alert>
              {mutation.variables?.notify ? <p className="text-body text-muted-foreground">{t("codeSending")}</p> : null}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" asChild>
                <Link to="/admin/gift-cards/$giftCardId" params={{ giftCardId: issued.giftCard.id }} onClick={() => onOpenChange(false)}>
                  {t("viewGiftCard")}
                </Link>
              </Button>
              <Button type="button" onClick={() => onOpenChange(false)}>{t("done")}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("issueGiftCard")}</DialogTitle>
              <DialogDescription>{t("issueHelp")}</DialogDescription>
            </DialogHeader>
            <form id="issue-gift-card" method="post" noValidate className="space-y-4" onSubmit={submit}>
              {mutation.isError ? (
                <Alert variant="destructive"><AlertDescription>{getServerFnError(mutation.error, t("issueFailed"))}</AlertDescription></Alert>
              ) : null}
              <GiftCardField id="gift-card-amount" label={t("amount")} error={error("amount")}>
                <MoneyInput
                  id="gift-card-amount"
                  currencyCode={currencyCode}
                  value={draft.amount}
                  disabled={busy}
                  aria-invalid={errors.amount ? true : undefined}
                  aria-describedby={fieldDescribedBy("gift-card-amount", error("amount"), false)}
                  onValueChange={(amount) => update({ amount })}
                />
              </GiftCardField>

              <div className="space-y-2">
                <GiftCardCheckRow
                  id="gift-card-has-expiry"
                  label={t("setExpiry")}
                  checked={draft.hasExpiry}
                  disabled={busy}
                  onChange={(hasExpiry) => update({ hasExpiry })}
                />
                {draft.hasExpiry ? (
                  <GiftCardField id="gift-card-expiry" label={t("expiryDate")} help={t("expiryHelp")} error={error("expiry")}>
                    <Input
                      id="gift-card-expiry"
                      type="date"
                      min={todayStoreDay()}
                      value={draft.expiryDay}
                      disabled={busy}
                      aria-invalid={errors.expiry ? true : undefined}
                      aria-describedby={fieldDescribedBy("gift-card-expiry", error("expiry"), true)}
                      onChange={(event) => update({ expiryDay: event.target.value })}
                    />
                  </GiftCardField>
                ) : null}
              </div>

              <GiftCardField id="gift-card-customer" label={t("customer")} help={t("customerHelp")}>
                <GiftCardCustomerPicker
                  id="gift-card-customer"
                  value={draft.customer?.id ?? ""}
                  selectedLabel={draft.customer?.name}
                  disabled={busy}
                  describedBy="gift-card-customer-help"
                  onChange={(customer) => update({ customer })}
                />
              </GiftCardField>

              <fieldset className="space-y-3 border-t pt-4">
                <legend className="sr-only">{t("recipientTitle")}</legend>
                <div className="space-y-1">
                  <p className="text-heading-sm">{t("recipientTitle")}</p>
                  <p className="text-body text-muted-foreground">{t("recipientHelp")}</p>
                </div>
                <GiftCardField id="gift-card-recipient-name" label={t("recipientName")}>
                  <Input
                    id="gift-card-recipient-name"
                    value={draft.recipientName}
                    maxLength={120}
                    autoComplete="off"
                    disabled={busy}
                    onChange={(event) => update({ recipientName: event.target.value })}
                  />
                </GiftCardField>
                <div className="grid gap-3 sm:grid-cols-3">
                  <GiftCardField id="gift-card-deliver-by" label={t("deliverBy")}>
                    <NativeSelect
                      id="gift-card-deliver-by"
                      value={draft.deliverBy}
                      disabled={busy}
                      onValueChange={(value) => update({ deliverBy: value === "sms" ? "sms" : "email" })}
                    >
                      <option value="email">{t("deliverByEmail")}</option>
                      <option value="sms">{t("deliverBySms")}</option>
                    </NativeSelect>
                  </GiftCardField>
                  <div className="sm:col-span-2">
                    <GiftCardField
                      id="gift-card-contact"
                      label={t(draft.deliverBy === "email" ? "recipientEmail" : "recipientPhone")}
                      error={error("contact")}
                    >
                      <Input
                        id="gift-card-contact"
                        type={draft.deliverBy === "email" ? "email" : "tel"}
                        inputMode={draft.deliverBy === "email" ? "email" : "tel"}
                        value={draft.contact}
                        maxLength={draft.deliverBy === "email" ? 254 : 40}
                        autoComplete="off"
                        disabled={busy}
                        aria-invalid={errors.contact ? true : undefined}
                        aria-describedby={fieldDescribedBy("gift-card-contact", error("contact"), false)}
                        onChange={(event) => update({ contact: event.target.value })}
                      />
                    </GiftCardField>
                  </div>
                </div>
                <GiftCardField
                  id="gift-card-message"
                  label={t("message")}
                  help={t("messageHelp", { max: GIFT_CARD_LIMITS.maxMessageLength })}
                >
                  <Textarea
                    id="gift-card-message"
                    value={draft.message}
                    maxLength={GIFT_CARD_LIMITS.maxMessageLength}
                    rows={2}
                    disabled={busy}
                    aria-describedby="gift-card-message-help"
                    onChange={(event) => update({ message: event.target.value })}
                  />
                </GiftCardField>
              </fieldset>

              <div className="space-y-4 border-t pt-4">
                <GiftCardField id="gift-card-note" label={t("note")} help={t("noteHelp")}>
                  <Textarea
                    id="gift-card-note"
                    value={draft.note}
                    maxLength={GIFT_CARD_LIMITS.maxNoteLength}
                    rows={2}
                    disabled={busy}
                    aria-describedby="gift-card-note-help"
                    onChange={(event) => update({ note: event.target.value })}
                  />
                </GiftCardField>
                <div className="space-y-1">
                  <GiftCardCheckRow
                    id="gift-card-notify"
                    label={t("notify")}
                    help={t("notifyHelp")}
                    checked={draft.notify}
                    disabled={busy}
                    onChange={(notify) => update({ notify })}
                  />
                  {errors.notify ? <p className="pl-7 text-body text-destructive">{error("notify")}</p> : null}
                </div>
              </div>
            </form>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
              <Button type="submit" form="issue-gift-card" loading={busy}>{t("issue")}</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
