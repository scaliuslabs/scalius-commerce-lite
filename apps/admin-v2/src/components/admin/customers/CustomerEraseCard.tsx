// Erasing a customer's personal data (final audit I10): a Super Admin's
// irreversible action, on a live record or one in Trash. The dialog says
// what goes and what stays, and the destructive button waits until the
// confirmation word is typed. The API refuses while an order is in
// progress; that refusal shows in the dialog with a link to the order.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { postApiV1AdminCustomersByIdErase } from "@scalius/api-client/sdk";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { Alert, AlertDescription } from "~/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { useMessages } from "~/i18n";
import { customerPageMessages } from "~/i18n/customer-page";
import { resourceMessages } from "~/i18n/resource";
import { apiData } from "~/lib/api";
import { getServerFnError } from "~/lib/api-helpers";
import { readAdminApiError } from "~/lib/admin-api-error";
import { queryKeys } from "~/lib/query-keys";
import { toast } from "~/lib/toast";

/** The order that blocks erasure, from a refusal's details (`{ orderId, orderNumber }`). */
function blockingOrder(error: unknown): { id: string; number: string } | null {
  const details = readAdminApiError(error)?.details as { orderId?: unknown; orderNumber?: unknown } | undefined;
  if (!details || typeof details.orderId !== "string") return null;
  const orderNumber = typeof details.orderNumber === "number" ? details.orderNumber : null;
  return { id: details.orderId, number: formatOrderNumber(orderNumber, details.orderId) };
}

function EraseRefusal({ error }: { error: unknown }) {
  const t = useMessages(customerPageMessages);
  const order = blockingOrder(error);
  if (!order) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{getServerFnError(error, t("eraseFailed"))}</AlertDescription>
      </Alert>
    );
  }
  // "Order {order} is still in progress…", with the order as a link wherever the language puts it.
  const [before, after] = t("eraseOrderOpen", { order: "\u0000" }).split("\u0000");
  return (
    <Alert variant="destructive">
      <AlertDescription>
        {before}
        <Link to="/admin/orders/$orderId" params={{ orderId: order.id }} className="text-link hover:underline">
          {order.number}
        </Link>
        {after}
      </AlertDescription>
    </Alert>
  );
}

export function EraseCustomerDialog({
  customerId,
  name,
  open,
  onOpenChange,
}: {
  customerId: string;
  /** The customer as every screen titles it. */
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useMessages(customerPageMessages);
  const tr = useMessages(resourceMessages);
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState("");
  const word = t("eraseConfirmWord");
  const confirmed = typed.trim().toLocaleUpperCase() === word.toLocaleUpperCase();
  const erase = useMutation({
    mutationFn: () => apiData(postApiV1AdminCustomersByIdErase({ path: { id: customerId } })),
    onSuccess: async () => {
      toast.success(t("erasedToast"));
      setTyped("");
      onOpenChange(false);
      // The record, its merged guest records, their orders and the lists all changed.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.customers.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.orders.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all }),
      ]);
    },
  });
  const changeOpen = (next: boolean) => {
    if (erase.isPending) return;
    // Each opening starts empty, without the last refusal.
    if (!next) {
      setTyped("");
      erase.reset();
    }
    onOpenChange(next);
  };
  const gone = ["eraseGoesContact", "eraseGoesAccount", "eraseGoesOrders", "eraseGoesWords"] as const;
  return (
    <AlertDialog open={open} onOpenChange={changeOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("eraseDialogTitle", { name })}</AlertDialogTitle>
          <AlertDialogDescription>{t("eraseDialogIntro")}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-3 text-body">
          <section className="flex flex-col gap-1">
            <h3 className="font-medium">{t("eraseGoesTitle")}</h3>
            <ul className="list-disc space-y-0.5 ps-5 text-muted-foreground">
              {gone.map((key) => <li key={key}>{t(key)}</li>)}
            </ul>
          </section>
          <section className="flex flex-col gap-1">
            <h3 className="font-medium">{t("eraseKeptTitle")}</h3>
            <ul className="list-disc space-y-0.5 ps-5 text-muted-foreground">
              <li>{t("eraseKeptOrders")}</li>
            </ul>
          </section>
          <p>{t("eraseApps")}</p>
        </div>
        <Field label={t("eraseConfirmLabel", { word })}>
          <Input
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={typed}
            disabled={erase.isPending}
            onChange={(event) => setTyped(event.target.value)}
          />
        </Field>
        {erase.isError ? <EraseRefusal error={erase.error} /> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={erase.isPending}>{tr("cancel")}</AlertDialogCancel>
          <Button type="button" variant="destructive" loading={erase.isPending} disabled={!confirmed} onClick={() => erase.mutate()}>
            {erase.isPending ? t("erasing") : t("eraseAction")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The customer page's last card: erase this customer's personal data. The
 * page shows it only to a Super Admin, and never for an erased record or one
 * merged into an account (that one is erased through its account).
 */
export function CustomerEraseCard({ customerId, name }: { customerId: string; name: string }) {
  const t = useMessages(customerPageMessages);
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("eraseTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-3">
        <p className="text-body text-muted-foreground">{t("eraseHelp")}</p>
        <Button type="button" variant="destructive" onClick={() => setOpen(true)}>{t("eraseAction")}</Button>
      </CardContent>
      <EraseCustomerDialog customerId={customerId} name={name} open={open} onOpenChange={setOpen} />
    </Card>
  );
}
