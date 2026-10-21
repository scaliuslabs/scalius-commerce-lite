// The customer page's saved payment methods (security audit N3): the cards
// or wallets a payment provider kept for charges without the buyer (a
// subscription's renewals), each with what it was kept for, the one app that
// may charge it ("Staff only" when none), and the order that kept it. Staff
// with customers.edit remove one when the buyer asks: the provider detaches
// it, then nothing can charge it again. Never a card number or the
// provider's reference.
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { InlineError } from "~/components/admin/states/InlineError";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { AppOwnerBadge } from "~/components/admin/apps/app-owner";
import { formatDateTime, useMessages } from "~/i18n";
import { CARD_BRAND_NAMES, customerPaymentMethodsMessages } from "~/i18n/customer-payment-methods";
import { getServerFnError } from "~/lib/api-helpers";
import { removeCustomerPaymentMethod } from "~/lib/api-mutations/customers";
import {
  customerPaymentMethodsQueryOptions,
  type CustomerSavedPaymentMethod,
} from "~/lib/api-query-options/customers";
import { resourceMessages } from "~/i18n/resource";
import { toast } from "~/lib/toast";

type Translate = ReturnType<typeof useMessages<keyof typeof customerPaymentMethodsMessages.en>>;

/** "Visa •••• 4242": the printed network name (else the provider's label, else "Card") and the last four digits. */
export function paymentMethodName(method: Pick<CustomerSavedPaymentMethod, "brand" | "label" | "last4">, t: Translate): string {
  const brand = CARD_BRAND_NAMES[method.brand?.trim().toLowerCase() ?? ""] ?? (method.label?.trim() || t("card"));
  return method.last4 ? `${brand} •••• ${method.last4}` : brand;
}

/** "Expires Aug 2027", or "Expired Sep 2026" once its month has passed; null without an expiry. */
export function paymentMethodExpiry(
  method: Pick<CustomerSavedPaymentMethod, "expiryMonth" | "expiryYear">,
  t: Translate,
  now: Date = new Date(),
): { text: string; expired: boolean } | null {
  const { expiryMonth: month, expiryYear: year } = method;
  if (!month || !year || month < 1 || month > 12) return null;
  // Mid-month in UTC, so no time zone moves it into another month.
  const date = formatDateTime(new Date(Date.UTC(year, month - 1, 15)), { month: "short", year: "numeric", timeZone: "UTC" });
  const expired = year < now.getUTCFullYear() || (year === now.getUTCFullYear() && month < now.getUTCMonth() + 1);
  return { text: t(expired ? "expired" : "expires", { date }), expired };
}

function PaymentMethodRow({ method, canEdit, busy, onRemove }: {
  method: CustomerSavedPaymentMethod;
  canEdit: boolean;
  busy: boolean;
  onRemove: () => void;
}) {
  const t = useMessages(customerPaymentMethodsMessages);
  const expiry = paymentMethodExpiry(method, t);
  return (
    <li className="flex items-start justify-between gap-2 py-3 first:pt-0 last:pb-0" data-payment-method={method.id}>
      <div className="min-w-0 space-y-0.5 text-body">
        <p className="font-medium tabular-nums">
          {paymentMethodName(method, t)}
        </p>
        {expiry ? <p className={expiry.expired ? "text-destructive" : "text-muted-foreground"}>{expiry.text}</p> : null}
        {method.savedFor ? <p className="break-words text-muted-foreground">{t("savedFor", { option: method.savedFor })}</p> : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
          {method.ownerAppId ? (
            <AppOwnerBadge namespace={method.ownerAppId} managedLabel={(app) => t("chargedBy", { app })} />
          ) : (
            <Badge variant="secondary">{t("staffOnly")}</Badge>
          )}
          {method.sourceOrderId ? (
            <Link to="/admin/orders/$orderId" params={{ orderId: method.sourceOrderId }} className="text-link hover:underline">
              {t("sourceOrder")}
            </Link>
          ) : null}
        </div>
      </div>
      {canEdit ? (
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onRemove}>{t("remove")}</Button>
      ) : null}
    </li>
  );
}

export function CustomerPaymentMethodsCard({ customerId, canEdit }: { customerId: string; canEdit: boolean }) {
  const t = useMessages(customerPaymentMethodsMessages);
  const r = useMessages(resourceMessages);
  const queryClient = useQueryClient();
  const methods = useQuery(customerPaymentMethodsQueryOptions(customerId));
  const [removing, setRemoving] = useState<CustomerSavedPaymentMethod | null>(null);
  const remove = useMutation({
    mutationFn: (methodId: string) => removeCustomerPaymentMethod(customerId, methodId),
    onSuccess: (result) => {
      queryClient.setQueryData(customerPaymentMethodsQueryOptions(customerId).queryKey, result);
      toast.success(t("removed"));
      setRemoving(null);
    },
    onError: (error) => {
      toast.error(getServerFnError(error, r("actionFailed")));
    },
  });
  const list = methods.data?.paymentMethods ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent>
        {methods.isError ? (
          <InlineError title={t("loadFailed")} error={methods.error} onRetry={() => void methods.refetch()} />
        ) : !methods.data ? (
          <Skeleton className="h-5 w-full" />
        ) : list.length === 0 ? (
          <p className="text-body text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="divide-y">
            {list.map((method) => (
              <PaymentMethodRow
                key={method.id}
                method={method}
                canEdit={canEdit}
                busy={remove.isPending}
                onRemove={() => {
                  remove.reset();
                  setRemoving(method);
                }}
              />
            ))}
          </ul>
        )}
      </CardContent>
      <ConfirmDialog
        open={canEdit && removing !== null}
        onOpenChange={(open) => { if (!open && !remove.isPending) setRemoving(null); }}
        title={t("removeTitle", { method: removing ? paymentMethodName(removing, t) : "" })}
        description={t("removeBody")}
        confirmLabel={t("remove")}
        isLoading={remove.isPending}
        onConfirm={() => {
          if (canEdit && removing) remove.mutate(removing.id);
        }}
      />
    </Card>
  );
}
