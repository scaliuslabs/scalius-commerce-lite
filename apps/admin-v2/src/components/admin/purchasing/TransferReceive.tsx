import { PresenceSlot, presenceKey } from "~/lib/realtime/store";
import { useState } from "react";
import { flushSync } from "react-dom";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "~/lib/toast";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { UnsavedChangesGuard } from "~/components/admin/shared/UnsavedChangesGuard";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { useMessages } from "~/i18n";
import { purchasingMessages } from "~/i18n/purchasing";
import { useReceiveTransfer, type Transfer } from "~/lib/api-query-options/purchasing";
import { receiptFingerprint, useOperationKeys } from "./operation-key";
import { PurchasingProblemBanner, readPurchasingProblem, type PurchasingProblem } from "./purchasing-problem";
import { isOpenTransfer, TransferStatusBadge } from "./purchasing-status";
import { ReceiveLines, readReceipt, type ReceivableLine, type ReceiveQuantities } from "./ReceiveLines";
import { Page } from "~/components/admin/resource/Page";

export function transferReceivableLines(transfer: Transfer): ReceivableLine[] {
  return transfer.lines.map((line) => ({
    id: line.id,
    productId: line.productId,
    productName: line.productName,
    optionLabel: line.optionLabel,
    sku: line.sku,
    barcode: line.barcode,
    open: line.inTransitQuantity,
    received: line.receivedQuantity,
    total: line.shippedQuantity,
    // A removed SKU still arrives: units in transit are already out of stock.
    retired: false,
  }));
}

/** Receive a transfer at its destination, in parts: scan or type what arrived. */
export function TransferReceive({ transfer, onReload }: { transfer: Transfer; onReload: () => Promise<void> }) {
  const t = useMessages(purchasingMessages);
  const navigate = useNavigate();
  const receive = useReceiveTransfer();
  const keys = useOperationKeys();
  const [quantities, setQuantities] = useState<ReceiveQuantities>({});
  const [problem, setProblem] = useState<PurchasingProblem | null>(null);
  const [touched, setTouched] = useState(false);
  const [reloading, setReloading] = useState(false);
  const lines = transferReceivableLines(transfer);
  const receipt = readReceipt(lines, quantities);
  const open = isOpenTransfer(transfer.status) && lines.some((line) => line.open > 0);
  const canSubmit = open && receipt.units > 0 && receipt.invalid.size === 0 && !receive.isPending;
  const detail = { to: "/admin/inventory/transfers/$transferId", params: { transferId: transfer.id } } as const;

  const submit = () => {
    setTouched(true);
    if (!canSubmit) return;
    setProblem(null);
    const operationKey = keys.keyFor(receiptFingerprint(transfer.id, receipt.lines));
    receive.mutate({ id: transfer.id, operationKey, lines: receipt.lines }, {
      onSuccess: () => {
        keys.reset();
        // Rendered before leaving, so the unsaved-count guard lets the page go.
        flushSync(() => setQuantities({}));
        toast.success(t("itemsReceived"));
        void navigate(detail);
      },
      onError: (error) => setProblem(readPurchasingProblem(error)),
    });
  };

  const reload = async () => {
    setReloading(true);
    try {
      await onReload();
      setProblem(null);
    } finally {
      setReloading(false);
    }
  };

  return (
    <Page data-presence-root={presenceKey("transfer", transfer.id)} width="detail">
      <UnsavedChangesGuard isDirty={receipt.units > 0} isSubmitting={receive.isPending} />
      <PageHeader
        presence={<PresenceSlot presenceKey={presenceKey("transfer", transfer.id)} revision={transfer.revision} dirty={receipt.units > 0} />}
        backTo={`/admin/inventory/transfers/${transfer.id}`}
        title={t("receiveTitle", { number: transfer.displayNumber })}
        status={<TransferStatusBadge status={transfer.status} />}
        actions={open ? (
          <Button type="button" loading={receive.isPending} disabled={receive.isPending} onClick={submit}>
            {receipt.units === 1 ? t("receiveCountOne") : receipt.units > 1 ? t("receiveCount", { count: receipt.units }) : t("receive")}
          </Button>
        ) : null}
      />
      <div className="space-y-4">
        <p className="text-body text-muted-foreground">
          {t("route", { origin: transfer.origin.name, destination: transfer.destination.name })}
          {" · "}
          {t("receivingAt", { location: transfer.destination.name })}
        </p>
        <PurchasingProblemBanner
          problem={problem}
          staleText={t("transferChanged")}
          failedText={t("receiveFailed")}
          onReload={() => void reload()}
          reloading={reloading}
        />
        {touched && receipt.units === 0 && receipt.invalid.size === 0 && open ? (
          <p role="alert" className="text-body text-destructive">{t("receiveNothing")}</p>
        ) : null}
        {open ? (
          <ReceiveLines
            lines={lines}
            quantities={quantities}
            onChange={(next) => {
              setQuantities(next);
              setProblem(null);
            }}
            notOnDocument={(code) => t("notOnTransfer", { code })}
            disabled={receive.isPending}
          />
        ) : (
          <Card>
            <CardContent className="space-y-3 pt-4">
              <p className="text-body">{t("nothingToReceive")}</p>
              <Button asChild variant="outline">
                <Link {...detail}>{t("backToTransfer", { number: transfer.displayNumber })}</Link>
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </Page>
  );
}
