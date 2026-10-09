import { useState } from "react";
import { flushSync } from "react-dom";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "~/lib/toast";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { UnsavedChangesGuard } from "~/components/admin/shared/UnsavedChangesGuard";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { useMessages } from "~/i18n";
import { purchasingMessages } from "~/i18n/purchasing";
import { useReceivePurchaseOrder, type PurchaseOrder } from "~/lib/api-query-options/purchasing";
import { receiptFingerprint, useOperationKeys } from "./operation-key";
import { PurchasingProblemBanner, readPurchasingProblem, type PurchasingProblem } from "./purchasing-problem";
import { isOpenPurchaseOrder, PurchaseOrderStatusBadge } from "./purchasing-status";
import { ReceiveLines, readReceipt, type ReceivableLine, type ReceiveQuantities } from "./ReceiveLines";
import { ChoiceField } from "~/components/ui/field";

export function receivableLines(order: PurchaseOrder): ReceivableLine[] {
  return order.lines.map((line) => ({
    id: line.id,
    productId: line.productId,
    productName: line.productName,
    optionLabel: line.optionLabel,
    sku: line.sku,
    barcode: line.barcode,
    open: line.openQuantity,
    received: line.receivedQuantity,
    total: line.quantity,
    retired: line.retired,
  }));
}

/**
 * Receive a purchase order (Shopify's "Receive inventory"): count what
 * arrived by scanning or typing, optionally move each SKU's cost per item to
 * the average, then book it at the destination in one write. One operation
 * key per counted receipt: a retry after a dropped connection replays it.
 */
export function PurchaseOrderReceive({ order, onReload }: { order: PurchaseOrder; onReload: () => Promise<void> }) {
  const t = useMessages(purchasingMessages);
  const navigate = useNavigate();
  const receive = useReceivePurchaseOrder();
  const keys = useOperationKeys();
  // Moving costs to the average writes them: only for staff who can see costs.
  const { inventory: { canViewCosts } } = useCatalogActionPermissions();
  const [quantities, setQuantities] = useState<ReceiveQuantities>({});
  const [costChoice, setUpdateCost] = useState(false);
  const updateCost = canViewCosts && costChoice;
  const [problem, setProblem] = useState<PurchasingProblem | null>(null);
  const [touched, setTouched] = useState(false);
  const [reloading, setReloading] = useState(false);
  const lines = receivableLines(order);
  const receipt = readReceipt(lines, quantities);
  const open = isOpenPurchaseOrder(order.status) && lines.some((line) => line.open > 0 && !line.retired);
  const canSubmit = open && receipt.units > 0 && receipt.invalid.size === 0 && !receive.isPending;
  const detail = { to: "/admin/inventory/purchase-orders/$purchaseOrderId", params: { purchaseOrderId: order.id } } as const;

  const submit = () => {
    setTouched(true);
    if (!canSubmit) return;
    setProblem(null);
    const operationKey = keys.keyFor(receiptFingerprint(order.id, receipt.lines, { updateCost }));
    receive.mutate(
      { id: order.id, operationKey, body: { lines: receipt.lines, updateCost } },
      {
        onSuccess: () => {
          keys.reset();
          // Rendered before leaving, so the unsaved-count guard lets the page go.
          flushSync(() => setQuantities({}));
          toast.success(t("itemsReceived"));
          void navigate(detail);
        },
        onError: (error) => setProblem(readPurchasingProblem(error)),
      },
    );
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
    <div className="mx-auto max-w-5xl">
      <UnsavedChangesGuard isDirty={receipt.units > 0} isSubmitting={receive.isPending} />
      <PageHeader
        backTo={`/admin/inventory/purchase-orders/${order.id}`}
        title={t("receiveTitle", { number: order.displayNumber })}
        badge={<PurchaseOrderStatusBadge status={order.status} />}
        actions={open ? (
          <Button type="button" loading={receive.isPending} disabled={receive.isPending} onClick={submit}>
            {receipt.units === 1 ? t("receiveCountOne") : receipt.units > 1 ? t("receiveCount", { count: receipt.units }) : t("receive")}
          </Button>
        ) : null}
      />
      <div className="space-y-4">
        <p className="text-body text-muted-foreground">{t("receivingAt", { location: order.destination.name })}</p>
        <PurchasingProblemBanner
          problem={problem}
          staleText={t("purchaseOrderChanged")}
          failedText={t("receiveFailed")}
          onReload={() => void reload()}
          reloading={reloading}
        />
        {touched && receipt.units === 0 && receipt.invalid.size === 0 && open ? (
          <p role="alert" className="text-body text-destructive">{t("receiveNothing")}</p>
        ) : null}
        {open ? (
          <>
            <ReceiveLines
              lines={lines}
              quantities={quantities}
              onChange={(next) => {
                setQuantities(next);
                setProblem(null);
              }}
              notOnDocument={(code) => t("notOnPurchaseOrder", { code })}
              disabled={receive.isPending}
            />
            {canViewCosts ? <Card>
              <CardContent className="pt-4">
                <ChoiceField
                  id="receive-update-cost"
                  label={t("updateCost")}
                  help={t("updateCostHelp")}
                  control={(
                    <Checkbox
                      id="receive-update-cost"
                      checked={updateCost}
                      disabled={receive.isPending}
                      aria-describedby="receive-update-cost-help"
                      onCheckedChange={(checked) => setUpdateCost(checked === true)}
                    />
                  )}
                />
              </CardContent>
            </Card> : null}
          </>
        ) : (
          <Card>
            <CardContent className="space-y-3 pt-4">
              <p className="text-body">{t("nothingToReceive")}</p>
              <Button asChild variant="outline">
                <Link {...detail}>{t("backToPurchaseOrder", { number: order.displayNumber })}</Link>
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
