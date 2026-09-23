import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle, Truck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { Button } from "../../ui/button";
import { Label } from "../../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import {
  deliveryProvidersQueryOptions,
  type DeliveryProviderRecord,
} from "~/lib/api-query-options/delivery";
import {
  getProviderReadinessMessage,
  resolveProviderReadiness,
} from "~/components/admin/delivery-providers/ProviderIcon";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { orderListMessages } from "~/i18n/order-list";
import type { BulkShipResultSummary } from "./order-bulk-actions";

interface BulkShipDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  isShipping: boolean;
  onConfirm: (providerId: string) => void;
  itemCount: number;
  resultSummary: BulkShipResultSummary | null;
}

/** Book one courier for every selected order; failed orders stay selected. */
export function BulkShipDialog({
  isOpen,
  onOpenChange,
  isShipping,
  onConfirm,
  itemCount,
  resultSummary,
}: BulkShipDialogProps) {
  const t = useMessages(orderListMessages);
  const tr = useMessages(resourceMessages);
  const [selectedProvider, setSelectedProvider] = useState("");
  const { data: providers = [], isLoading } = useQuery({
    ...deliveryProvidersQueryOptions(),
    enabled: isOpen,
    select: (data) => (Array.isArray(data) ? (data as DeliveryProviderRecord[]) : []),
  });
  const selectedProviderReadiness = (() => {
    const record = providers.find((provider) => provider.id === selectedProvider);
    return record ? resolveProviderReadiness(record) : null;
  })();
  const readyCount = providers.filter((provider) => resolveProviderReadiness(provider).canCreateShipment).length;
  const blocker = selectedProviderReadiness && !selectedProviderReadiness.canCreateShipment
    ? getProviderReadinessMessage(selectedProviderReadiness)
    : null;
  const visibleFailures = resultSummary?.failures.slice(0, 5) ?? [];
  const hiddenFailures = (resultSummary?.failures.length ?? 0) - visibleFailures.length;

  const handleSubmit = () => {
    if (isShipping || !selectedProvider || !selectedProviderReadiness?.canCreateShipment) return;
    onConfirm(selectedProvider);
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(nextOpen) => {
        if (isShipping && !nextOpen) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("shipTitle", { count: itemCount })}</DialogTitle>
          <DialogDescription>{t("shipBody")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="bulk-ship-courier">{t("courier")}</Label>
          <Select
            value={selectedProvider}
            onValueChange={setSelectedProvider}
            disabled={isLoading || isShipping}
          >
            <SelectTrigger id="bulk-ship-courier">
              <SelectValue placeholder={t("chooseCourier")} />
            </SelectTrigger>
            <SelectContent>
              {providers.map((provider) => {
                const readiness = resolveProviderReadiness(provider);
                return (
                  <SelectItem
                    key={provider.id}
                    value={provider.id}
                    disabled={!readiness.canCreateShipment}
                  >
                    {readiness.canCreateShipment
                      ? provider.name
                      : t("courierNotReady", { name: provider.name })}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          {!isLoading && providers.length === 0 ? (
            <p className="text-body text-muted-foreground">{t("noCouriers")}</p>
          ) : !isLoading && readyCount === 0 ? (
            <p className="text-body text-muted-foreground">{t("noReadyCouriers")}</p>
          ) : null}
          {blocker ? <p className="text-body text-destructive">{blocker}</p> : null}
        </div>

        {resultSummary ? (
          <div className="space-y-1 border-t pt-4 text-body" role="status">
            <p className="font-medium">
              {t("shipResult", { success: resultSummary.successCount, total: resultSummary.totalProcessed })}
            </p>
            <p className="text-muted-foreground">{t("shipFailedStay", { count: resultSummary.failureCount })}</p>
            <ul className="space-y-1 text-muted-foreground">
              {visibleFailures.map((failure) => (
                <li key={failure.orderId} className="break-words">
                  <span className="font-medium text-foreground">#{failure.orderId}</span>: {failure.error}
                </li>
              ))}
            </ul>
            {hiddenFailures > 0 ? (
              <p className="text-muted-foreground">{t("moreFailed", { count: hiddenFailures })}</p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isShipping}>
            {tr("cancel")}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isShipping || !selectedProvider || !selectedProviderReadiness?.canCreateShipment}
          >
            {isShipping ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Truck className="h-4 w-4" />}
            {t("shipOrders")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
