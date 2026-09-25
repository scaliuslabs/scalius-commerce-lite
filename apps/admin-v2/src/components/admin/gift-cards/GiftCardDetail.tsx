import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { unixToDate } from "@scalius/shared/timestamps";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { usePermissions } from "~/contexts/PermissionContext";
import { formatDateTime, useMessages } from "~/i18n";
import { giftCardsMessages, type GiftCardMessageKey } from "~/i18n/gift-cards";
import type { GiftCardDetail as GiftCardDetailRecord, GiftCardTransaction } from "~/lib/api-query-options/gift-cards";
import { AdjustBalanceDialog, EditDetailsDialog, ExpiryDialog, giftCardErrorText } from "./GiftCardActionDialogs";
import { GiftCardStatusBadge } from "./gift-card-fields";
import { formatGiftCardLastDay, formatGiftCardMoney } from "./gift-card-format";
import { useResendGiftCard, useUpdateGiftCard } from "./use-gift-card-mutations";

type DialogName = "adjust" | "expiry" | "details" | "disable" | null;

function when(value: string | number | null | undefined, options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }): string {
  const date = unixToDate(value ?? null);
  return date ? formatDateTime(date, options) : "—";
}

/** The API sends the order number already formatted ("#1001"). */
function OrderLink({ id, number }: { id: string; number: string | null }) {
  const t = useMessages(giftCardsMessages);
  return (
    <Link to="/admin/orders/$orderId" params={{ orderId: id }} className="text-link hover:underline">
      {t("orderNumber", { number: number ?? `#${id}` })}
    </Link>
  );
}

/** Where the card came from: an order (bought or store credit) or a staff member. */
function SourceText({ card }: { card: GiftCardDetailRecord }) {
  const t = useMessages(giftCardsMessages);
  const order = card.sourceOrder;
  if (card.source === "manual") {
    return <>{card.issuedBy?.name ? t("source_manual", { name: card.issuedBy.name }) : t("source_manualNoName")}</>;
  }
  const withOrder = card.source === "refund" ? "source_refund" : "source_purchase";
  if (!order) return <>{t(card.source === "refund" ? "source_refundNoOrder" : "source_purchaseNoOrder")}</>;
  // "Bought in order {order}": the order number is a link inside the sentence.
  const [before, after] = t(withOrder, { order: "\u0000" }).split("\u0000");
  return <>{before}<OrderLink id={order.id} number={order.orderNumber} />{after}</>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-body text-muted-foreground">{label}</dt>
      <dd className="text-body">{children}</dd>
    </div>
  );
}

function actorText(transaction: GiftCardTransaction, t: (key: GiftCardMessageKey, vars?: Record<string, string | number>) => string): string {
  if (transaction.actorType === "admin") return transaction.actorName ? t("byName", { name: transaction.actorName }) : t("byStaff");
  if (transaction.actorType === "customer") return t("byCustomer");
  return t("bySystem");
}

/** Newest first: what moved the balance, by whom, on which order. */
function TransactionsCard({ card, transactions }: { card: GiftCardDetailRecord; transactions: GiftCardTransaction[] }) {
  const t = useMessages(giftCardsMessages);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("transactions")}</CardTitle>
      </CardHeader>
      {transactions.length === 0 ? (
        <CardContent><p className="text-body text-muted-foreground">{t("noTransactions")}</p></CardContent>
      ) : (
        <ul className="divide-y border-t">
          {transactions.map((transaction) => (
            <li key={transaction.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
              <div className="min-w-0 space-y-0.5">
                <p className="text-body font-medium">{t(`kind_${transaction.kind}`)}</p>
                <p className="text-body text-muted-foreground">
                  {when(transaction.createdAt)} · {actorText(transaction, t)}
                  {transaction.orderId ? (
                    <> · <OrderLink id={transaction.orderId} number={transaction.orderNumber} /></>
                  ) : null}
                </p>
                {transaction.reason ? <p className="break-words text-body">“{transaction.reason}”</p> : null}
              </div>
              <div className="shrink-0 space-y-0.5 sm:text-right">
                <p className="text-body font-medium tabular-nums">
                  {transaction.amountMinor > 0 ? "+" : ""}{formatGiftCardMoney(transaction.amountMinor, card.currencyCode)}
                </p>
                <p className="text-body tabular-nums text-muted-foreground">
                  {t("balanceAfter", { amount: formatGiftCardMoney(transaction.balanceAfterMinor, card.currencyCode) })}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Shopify's gift card page: balance and facts, the transactions, and the card's customer and note. */
export function GiftCardDetail({ card, transactions }: { card: GiftCardDetailRecord; transactions: GiftCardTransaction[] }) {
  const t = useMessages(giftCardsMessages);
  const { hasPermission } = usePermissions();
  const canManage = hasPermission(PERMISSIONS.GIFT_CARDS_MANAGE);
  const [dialog, setDialog] = useState<DialogName>(null);
  const update = useUpdateGiftCard(card.id);
  const resend = useResendGiftCard(card.id);
  const closeDialog = (open: boolean) => { if (!open) setDialog(null); };
  const isDisabled = card.status === "disabled";
  const lastDay = formatGiftCardLastDay(card.expiresAt);
  const recipientContact = card.recipientEmail ?? card.recipientPhone;
  const canResend = Boolean(recipientContact || card.customer);

  const setStatus = (status: "active" | "disabled") => {
    update.mutate(
      { version: card.version, status },
      {
        onSuccess: () => {
          toast.success(t(status === "disabled" ? "disabled" : "enabled"));
          setDialog(null);
        },
        onError: (error) => {
          toast.error(giftCardErrorText(error, "saveFailed"));
          setDialog(null);
        },
      },
    );
  };

  const sendAgain = () => {
    resend.mutate(undefined, {
      onSuccess: () => toast.success(t("resent")),
      onError: (error) => toast.error(giftCardErrorText(error, "resendFailed")),
    });
  };

  const actions = canManage ? (
    <>
      {canResend ? (
        <Button type="button" variant="outline" loading={resend.isPending} onClick={sendAgain}>{t("resend")}</Button>
      ) : null}
      <Button type="button" variant="outline" onClick={() => setDialog("expiry")}>{t("changeExpiry")}</Button>
      {isDisabled ? (
        <Button type="button" variant="outline" loading={update.isPending} onClick={() => setStatus("active")}>{t("enable")}</Button>
      ) : (
        <Button type="button" variant="outline" onClick={() => setDialog("disable")}>{t("disable")}</Button>
      )}
      <Button type="button" onClick={() => setDialog("adjust")}>{t("adjustBalance")}</Button>
    </>
  ) : null;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        backTo="/admin/gift-cards"
        title={t("detailTitle", { last4: card.last4 })}
        badge={<GiftCardStatusBadge card={card} />}
        actions={actions}
      />
      {!canManage ? (
        <p role="status" className="mb-4 rounded-lg bg-muted px-4 py-2 text-body text-muted-foreground">{t("readOnly")}</p>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Card>
            <CardContent className="space-y-4 pt-4">
              <div className="flex flex-col gap-1">
                <p className="text-body text-muted-foreground">{t("balance")}</p>
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-heading-lg tabular-nums">{formatGiftCardMoney(card.balanceMinor, card.currencyCode)}</span>
                  <span className="text-body tabular-nums text-muted-foreground">
                    / {formatGiftCardMoney(card.initialAmountMinor, card.currencyCode)}
                  </span>
                </p>
              </div>
              <dl className="grid gap-4 border-t pt-4 sm:grid-cols-2">
                <Fact label={t("initialValue")}>
                  <span className="tabular-nums">{formatGiftCardMoney(card.initialAmountMinor, card.currencyCode)}</span>
                </Fact>
                <Fact label={t("expires")}>
                  {lastDay ? (card.expired ? t("expiredOn", { date: lastDay }) : t("expiresOn", { date: lastDay })) : t("never")}
                </Fact>
                <Fact label={t("source")}><SourceText card={card} /></Fact>
                <Fact label={t("created")}>{when(card.createdAt)}</Fact>
              </dl>
            </CardContent>
          </Card>
          <TransactionsCard card={card} transactions={transactions} />
        </div>

        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-2">
              <CardTitle>{t("customerTitle")}</CardTitle>
              {canManage ? (
                <Button type="button" variant="link" size="sm" onClick={() => setDialog("details")}>{t("edit")}</Button>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-4">
              {card.customer ? (
                <Link to="/admin/customers/$customerId/edit" params={{ customerId: card.customer.id }} className="text-body text-link hover:underline">
                  {card.customer.name}
                </Link>
              ) : (
                <p className="text-body text-muted-foreground">{t("noCustomer")}</p>
              )}
              <div className="space-y-1 border-t pt-4">
                <p className="text-heading-sm">{t("recipient")}</p>
                {card.recipientName || recipientContact ? (
                  <>
                    {card.recipientName ? <p className="text-body">{card.recipientName}</p> : null}
                    {recipientContact ? <p className="break-all text-body text-muted-foreground">{recipientContact}</p> : null}
                  </>
                ) : (
                  <p className="text-body text-muted-foreground">{t("noRecipient")}</p>
                )}
                {card.message ? <p className="break-words pt-1 text-body">“{card.message}”</p> : null}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-2">
              <CardTitle>{t("noteTitle")}</CardTitle>
              {canManage ? (
                <Button type="button" variant="link" size="sm" onClick={() => setDialog("details")}>{t("edit")}</Button>
              ) : null}
            </CardHeader>
            <CardContent>
              <p className={card.note ? "whitespace-pre-wrap break-words text-body" : "text-body text-muted-foreground"}>
                {card.note ?? t("noNote")}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {canManage ? (
        <>
          <AdjustBalanceDialog card={card} open={dialog === "adjust"} onOpenChange={closeDialog} />
          <ExpiryDialog card={card} open={dialog === "expiry"} onOpenChange={closeDialog} />
          <EditDetailsDialog card={card} open={dialog === "details"} onOpenChange={closeDialog} />
          <ConfirmDialog
            open={dialog === "disable"}
            onOpenChange={(open) => { if (!open && !update.isPending) setDialog(null); }}
            title={t("disableTitle", { last4: card.last4 })}
            description={t("disableBody")}
            confirmLabel={t("disable")}
            cancelLabel={t("cancel")}
            isLoading={update.isPending}
            onConfirm={() => setStatus("disabled")}
          />
        </>
      ) : null}
    </div>
  );
}

