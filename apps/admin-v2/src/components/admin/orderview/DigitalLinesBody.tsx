import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  postApiV1AdminDigitalEntitlementsByIdReset,
  postApiV1AdminDigitalEntitlementsByIdRevoke,
  postApiV1AdminOrdersByIdDigitalResend,
} from "@scalius/api-client/sdk";
import { maskLicenceKey } from "@scalius/shared/digital";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useMessages } from "~/i18n";
import { digitalMessages } from "~/i18n/digital";
import { resourceMessages } from "~/i18n/resource";
import { apiData } from "~/lib/api";
import { invalidateOrder, orderErrorMessage } from "~/lib/api-mutations/orders";
import { formatOrderTimestamp } from "./formatters";
import type { DigitalDelivery, LineDownload } from "./digital-lines";

/**
 * What the order delivered digitally, per line: each file with "3 of 5
 * downloads", its expiry and "Allow more downloads" / "Revoke access"; licence
 * keys by their last 4 only (staff never see a key). Resend sends the buyer
 * every file and key the order still gives access to. A paid line that
 * auto-delivery couldn't hand over says why and where to fix it.
 */
export function DigitalLinesBody({ orderId, delivery }: { orderId: string; delivery: DigitalDelivery }) {
  const t = useMessages(digitalMessages);
  const r = useMessages(resourceMessages);
  const queryClient = useQueryClient();
  const { lines, accessEnded } = delivery;
  const canEdit = useOrderActionPermissions().canEditOrders && !accessEnded;
  const [revoking, setRevoking] = useState<LineDownload | null>(null);
  const resendKey = useRef<string | null>(null);
  const done = (message: string) => {
    toast.success(message);
    void invalidateOrder(queryClient, orderId);
  };
  const failed = (error: Error) => toast.error(orderErrorMessage(error));

  const reset = useMutation({
    mutationFn: (entitlementId: string) => apiData(postApiV1AdminDigitalEntitlementsByIdReset({ path: { id: entitlementId } })),
    onSuccess: () => done(t("downloadsReset")),
    onError: failed,
  });
  const revoke = useMutation({
    mutationFn: (entitlementId: string) => apiData(postApiV1AdminDigitalEntitlementsByIdRevoke({ path: { id: entitlementId } })),
    onSuccess: () => {
      setRevoking(null);
      done(t("accessRevoked"));
    },
    onError: failed,
  });
  // One key per attempt: a retry after a failure replays it; a success ends it.
  const resend = useMutation({
    mutationFn: (requestKey: string) => apiData(postApiV1AdminOrdersByIdDigitalResend({ path: { id: orderId }, body: { requestKey } })),
    onSuccess: () => {
      resendKey.current = null;
      done(t("resent"));
    },
    onError: failed,
  });
  const hasDelivered = lines.some((line) => line.downloads.length > 0 || line.keys.length > 0);
  const ended = accessEnded ? <Badge variant="secondary">{t("accessEnded")}</Badge> : null;

  return (
    <Card data-testid="digital-lines">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle>{t("orderTitle")}</CardTitle>
          {canEdit && hasDelivered ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={resend.isPending}
              onClick={() => {
                resendKey.current ??= crypto.randomUUID();
                resend.mutate(resendKey.current);
              }}
            >
              {t("resend")}
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {lines.map(({ item, downloads, keys, undelivered }) => (
            <li key={item.id} className="space-y-2 py-3 text-body first:pt-0 last:pb-0">
              <div className="break-words">
                <p className="font-medium">{item.productName || t("unnamedProduct")}</p>
                {item.variantLabel ? <p className="text-muted-foreground">{item.variantLabel}</p> : null}
              </div>
              {undelivered ? (
                <p role="status" className="text-warning">
                  {t("undelivered")}{" "}
                  {item.productId ? (
                    <Link to="/admin/products/$productId/edit" params={{ productId: item.productId }} className="text-link hover:underline">
                      {t("openProduct")}
                    </Link>
                  ) : null}
                </p>
              ) : null}
              {downloads.map((entry) => {
                const expiry = entry.expiresAt ? formatOrderTimestamp(entry.expiresAt) : null;
                const expired = entry.expiresAt !== null && Date.parse(entry.expiresAt) <= Date.now();
                const facts = [
                  entry.downloadLimit === null
                    ? t("downloadsCount", { count: entry.downloadCount })
                    : t("downloadsOf", { count: entry.downloadCount, limit: entry.downloadLimit }),
                  expiry ? t(expired ? "expired" : "expires", { date: expiry }) : null,
                ].filter(Boolean).join(" · ");
                const canReset = canEdit && !entry.revoked && entry.downloadLimit !== null && entry.downloadCount > 0;
                return (
                  <div key={entry.entitlementId} className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 break-words">
                      <p className="flex flex-wrap items-center gap-2">
                        <span>{entry.displayName}</span>
                        {entry.revoked ? <Badge variant="secondary">{t("revoked")}</Badge> : ended}
                      </p>
                      <p className="text-muted-foreground tabular-nums">{facts}</p>
                    </div>
                    {canEdit && !entry.revoked ? (
                      <div className="flex flex-wrap gap-2">
                        {canReset ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            loading={reset.isPending && reset.variables === entry.entitlementId}
                            disabled={reset.isPending}
                            onClick={() => reset.mutate(entry.entitlementId)}
                          >
                            {t("allowMore")}
                          </Button>
                        ) : null}
                        <Button type="button" variant="ghost" size="sm" onClick={() => setRevoking(entry)}>{t("revokeAccess")}</Button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {keys.length > 0 ? (
                <div>
                  <p className="flex flex-wrap items-center gap-2">{t("orderKeys")}{ended}</p>
                  <ul className="flex flex-wrap gap-x-4 text-muted-foreground">
                    {keys.map((entry) => <li key={entry.keyId}><code>{maskLicenceKey(entry.last4)}</code></li>)}
                  </ul>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => { if (!open && !revoke.isPending) setRevoking(null); }}
        title={t("revokeAccessTitle", { name: revoking?.displayName ?? "" })}
        description={t("revokeAccessBody")}
        confirmLabel={t("revokeAccess")}
        cancelLabel={r("cancel")}
        isLoading={revoke.isPending}
        onConfirm={() => { if (revoking) revoke.mutate(revoking.entitlementId); }}
      />
    </Card>
  );
}
