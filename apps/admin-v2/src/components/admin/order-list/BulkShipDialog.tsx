import React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { Button } from "../../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { LoaderCircle, Truck } from "lucide-react";
import { toast } from "sonner";
import { deliveryProvidersQueryOptions } from "~/lib/api-query-options/delivery";
import type { DeliveryProviderRecord } from "~/types/api-responses";
import {
  getProviderReadinessLabel,
  getProviderReadinessMessage,
  resolveProviderReadiness,
} from "~/components/admin/delivery-providers/ProviderIcon";

export interface BulkShipResultSummary {
  totalProcessed: number;
  successCount: number;
  failureCount: number;
  failures: Array<{
    orderId: string;
    error: string;
  }>;
}

interface BulkShipDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  isShipping: boolean;
  onConfirm: (providerId: string) => void;
  itemCount: number;
  resultSummary: BulkShipResultSummary | null;
}

export function BulkShipDialog({
  isOpen,
  onOpenChange,
  isShipping,
  onConfirm,
  itemCount,
  resultSummary,
}: BulkShipDialogProps) {
  const [selectedProvider, setSelectedProvider] = React.useState("");
  const visibleFailures = resultSummary?.failures.slice(0, 5) ?? [];
  const hiddenFailureCount = Math.max(
    (resultSummary?.failures.length ?? 0) - visibleFailures.length,
    0,
  );

  const { data: providers = [], isLoading: isLoadingProviders } = useQuery({
    ...deliveryProvidersQueryOptions(),
    enabled: isOpen,
    select: (data) =>
      (Array.isArray(data) ? (data as DeliveryProviderRecord[]) : []),
  });
  const selectedProviderRecord = providers.find(
    (provider) => provider.id === selectedProvider,
  );
  const selectedProviderReadiness = selectedProviderRecord
    ? resolveProviderReadiness(selectedProviderRecord)
    : null;
  const selectedProviderBlocker = selectedProviderReadiness &&
    !selectedProviderReadiness.canCreateShipment
      ? getProviderReadinessMessage(selectedProviderReadiness)
      : "";
  const readyProviderCount = providers.filter(
    (provider) => resolveProviderReadiness(provider).canCreateShipment,
  ).length;

  const handleSubmit = () => {
    if (isShipping) return;
    if (!selectedProvider) {
      toast.error("Error", { description: "Please select a delivery provider." });
      return;
    }
    if (!selectedProviderRecord || !selectedProviderReadiness?.canCreateShipment) {
      toast.error("Provider cannot create shipments", {
        description: selectedProviderBlocker ||
          "Complete provider setup before shipping orders.",
      });
      return;
    }
    onConfirm(selectedProvider);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (isShipping && !nextOpen) return;
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[425px] bg-[var(--card)] border-[var(--border)] rounded-xl shadow-lg border backdrop-blur-lg">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold leading-tight tracking-tight text-[var(--foreground)]">
            Ship Orders
          </DialogTitle>
          <DialogDescription className="text-base text-[var(--muted-foreground)] mt-2">
            Create shipments for the {itemCount} selected orders
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <label
              htmlFor="provider"
              className="text-sm font-medium text-[var(--foreground)]"
            >
              Delivery Provider
            </label>

            <Select
              value={selectedProvider}
              onValueChange={setSelectedProvider}
              disabled={isLoadingProviders || isShipping}
            >
              <SelectTrigger className="h-10 transition-all duration-200 hover:border-[var(--muted)] focus:border-primary focus:ring-2 focus:ring-primary/20 bg-[var(--card)] border-[var(--border)] hover:bg-[var(--muted)]">
                <SelectValue placeholder="Select a delivery provider" />
              </SelectTrigger>
              <SelectContent className="bg-[var(--popover)] border-[var(--border)]">
                {providers.map((provider) => {
                  const readiness = resolveProviderReadiness(provider);
                  return (
                    <SelectItem
                      key={provider.id}
                      value={provider.id}
                      disabled={!readiness.canCreateShipment}
                      className="transition-colors hover:bg-[var(--muted)]"
                    >
                      <span className="flex items-center gap-1.5">
                        <span>{provider.name}</span>
                        <span className="text-xs text-[var(--muted-foreground)]">
                          {getProviderReadinessLabel(readiness)}
                        </span>
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>

            {isLoadingProviders && (
              <div className="flex items-center justify-center py-2">
                <LoaderCircle className="animate-spin h-5 w-5 text-[var(--muted-foreground)]" />
              </div>
            )}

            {providers.length === 0 && !isLoadingProviders && (
              <p className="mt-1 rounded-md border border-[var(--border)] bg-[var(--muted)] p-2 text-sm text-[var(--muted-foreground)]">
                No delivery providers found. Please add one in settings.
              </p>
            )}

            {providers.length > 0 && readyProviderCount === 0 && !isLoadingProviders && (
              <p className="mt-1 rounded-md border border-amber-200 bg-amber-50/80 p-2 text-sm text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100">
                No shipment-ready delivery providers.{" "}
                {getProviderReadinessMessage(resolveProviderReadiness(providers[0]))}
              </p>
            )}

            {selectedProviderBlocker && (
              <p className="mt-1 rounded-md border border-amber-200 bg-amber-50/80 p-2 text-sm text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100">
                {selectedProviderBlocker}
              </p>
            )}
          </div>

          {resultSummary && (
            <div className="rounded-md border border-[var(--border)] bg-[var(--muted)] p-3 text-sm">
              <div className="font-medium text-[var(--foreground)]">
                {resultSummary.successCount} of {resultSummary.totalProcessed} shipped
              </div>
              <div className="mt-1 text-[var(--muted-foreground)]">
                {resultSummary.failureCount} failed and remain selected.
              </div>
              {visibleFailures.length > 0 && (
                <ul className="mt-2 space-y-1 text-[var(--muted-foreground)]">
                  {visibleFailures.map((failure) => (
                    <li key={failure.orderId} className="break-words">
                      <span className="font-medium text-[var(--foreground)]">
                        {failure.orderId}
                      </span>
                      : {failure.error}
                    </li>
                  ))}
                </ul>
              )}
              {hiddenFailureCount > 0 && (
                <div className="mt-2 text-[var(--muted-foreground)]">
                  {hiddenFailureCount} more failed order
                  {hiddenFailureCount === 1 ? "" : "s"}.
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isShipping}
            className="h-10 transition-all duration-200 bg-[var(--card)] border-[var(--border)] hover:bg-[var(--muted)]"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={
              isShipping ||
              !selectedProvider ||
              selectedProviderReadiness?.canCreateShipment === false
            }
            className="h-10 transition-all duration-200 hover:shadow-md focus:ring-2 focus:ring-primary/40"
          >
            {isShipping ? (
              <>
                <LoaderCircle className="animate-spin -ml-1 mr-2 h-4 w-4" />
                Shipping...
              </>
            ) : (
              <>
                <Truck className="mr-1.5 h-4 w-4" />
                Ship Orders
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
