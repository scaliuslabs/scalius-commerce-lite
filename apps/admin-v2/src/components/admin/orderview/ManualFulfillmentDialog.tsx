import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Loader2, PackageCheck } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCreateFulfillmentShipment } from "@/lib/api-mutations/orders";
import type { Order, OrderItem } from "./types";

const FULFILLMENT_READY_ORDER_STATUSES = new Set(["confirmed", "shipped"]);
const FULFILLABLE_ITEM_STATUSES = new Set(["pending", "picked", "packed"]);
const SHIPPED_ITEM_STATUSES = new Set(["shipped", "delivered"]);

interface ManualFulfillmentDialogProps {
  order: Order;
}

function normalizeStatus(status?: string | null) {
  return (status ?? "pending").toLowerCase();
}

function formatStatus(status: string) {
  return status
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getItemLabel(item: OrderItem) {
  const variantParts = [item.variantSize, item.variantColor].filter(Boolean);
  return variantParts.length > 0
    ? `${item.productName ?? "Unnamed product"} (${variantParts.join(" / ")})`
    : item.productName ?? "Unnamed product";
}

function isFulfillableItem(item: OrderItem) {
  return FULFILLABLE_ITEM_STATUSES.has(normalizeStatus(item.fulfillmentStatus));
}

function cleanOptional(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function ManualFulfillmentDialog({ order }: ManualFulfillmentDialogProps) {
  const [open, setOpen] = useState(false);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [courierName, setCourierName] = useState("Own courier");
  const [trackingId, setTrackingId] = useState("");
  const [trackingUrl, setTrackingUrl] = useState("");
  const [shipmentAmount, setShipmentAmount] = useState("");
  const [note, setNote] = useState("");
  const mutation = useCreateFulfillmentShipment();

  const fulfillableItems = useMemo(
    () => order.items.filter(isFulfillableItem),
    [order.items],
  );
  const fulfillableItemIds = useMemo(
    () => fulfillableItems.map((item) => item.id),
    [fulfillableItems],
  );
  const orderStatus = normalizeStatus(order.status);
  const canCreateShipment =
    FULFILLMENT_READY_ORDER_STATUSES.has(orderStatus) &&
    fulfillableItemIds.length > 0;
  const allFulfillableSelected =
    fulfillableItemIds.length > 0 &&
    fulfillableItemIds.every((id) => selectedItemIds.includes(id));
  const isFinalShipment =
    selectedItemIds.length > 0 &&
    selectedItemIds.length === fulfillableItemIds.length;

  useEffect(() => {
    if (open) {
      setSelectedItemIds(fulfillableItemIds);
    }
  }, [fulfillableItemIds, open]);

  const toggleItem = (item: OrderItem, checked: boolean) => {
    if (!isFulfillableItem(item)) return;
    setSelectedItemIds((current) =>
      checked
        ? [...new Set([...current, item.id])]
        : current.filter((id) => id !== item.id),
    );
  };

  const toggleAll = (checked: boolean) => {
    setSelectedItemIds(checked ? fulfillableItemIds : []);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selectedItemIds.length === 0) {
      toast.error("Select at least one item");
      return;
    }

    const parsedShipmentAmount =
      shipmentAmount.trim().length > 0 ? Number(shipmentAmount) : undefined;
    if (
      parsedShipmentAmount !== undefined &&
      (!Number.isFinite(parsedShipmentAmount) || parsedShipmentAmount < 0)
    ) {
      toast.error("Shipment amount must be zero or higher");
      return;
    }

    mutation.mutate(
      {
        orderId: order.id,
        itemIds: selectedItemIds,
        courierName: cleanOptional(courierName),
        trackingId: cleanOptional(trackingId),
        trackingUrl: cleanOptional(trackingUrl),
        note: cleanOptional(note),
        shipmentAmount: parsedShipmentAmount,
        isFinalShipment,
      },
      {
        onSuccess: () => setOpen(false),
      },
    );
  };

  const triggerTitle = canCreateShipment
    ? "Create own courier fulfillment"
    : "Confirm the order before fulfillment";

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !mutation.isPending && setOpen(nextOpen)}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="w-full gap-2"
          disabled={!canCreateShipment}
          title={triggerTitle}
        >
          <PackageCheck className="h-4 w-4" />
          Own Courier
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Own courier fulfillment</DialogTitle>
          <DialogDescription className="sr-only">
            Create a fulfillment shipment for selected order items.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-5" onSubmit={handleSubmit}>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="manual-fulfillment-all">Items</Label>
              <div className="flex items-center gap-2">
                <Badge variant={isFinalShipment ? "default" : "secondary"}>
                  {isFinalShipment ? "Final" : "Partial"}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {selectedItemIds.length}/{fulfillableItemIds.length}
                </span>
              </div>
            </div>

            <div className="rounded-md border border-border">
              <label
                htmlFor="manual-fulfillment-all"
                className="flex cursor-pointer items-center gap-3 border-b border-border px-3 py-2 text-sm"
              >
                <Checkbox
                  id="manual-fulfillment-all"
                  checked={allFulfillableSelected}
                  onCheckedChange={(checked) => toggleAll(checked === true)}
                  disabled={mutation.isPending || fulfillableItemIds.length === 0}
                />
                <span className="font-medium">All unshipped items</span>
              </label>

              <div className="max-h-56 overflow-y-auto">
                {order.items.map((item) => {
                  const status = normalizeStatus(item.fulfillmentStatus);
                  const isFulfillable = isFulfillableItem(item);
                  const isShipped = SHIPPED_ITEM_STATUSES.has(status);
                  const checked = selectedItemIds.includes(item.id);

                  return (
                    <label
                      key={item.id}
                      htmlFor={`manual-fulfillment-item-${item.id}`}
                      className="flex cursor-pointer items-start gap-3 border-b border-border px-3 py-3 last:border-b-0"
                    >
                      <Checkbox
                        id={`manual-fulfillment-item-${item.id}`}
                        checked={checked}
                        onCheckedChange={(nextChecked) =>
                          toggleItem(item, nextChecked === true)
                        }
                        disabled={!isFulfillable || mutation.isPending}
                        className="mt-0.5"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {getItemLabel(item)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          Qty {item.quantity}
                        </span>
                      </span>
                      <Badge variant={isShipped ? "outline" : "secondary"}>
                        {formatStatus(status)}
                      </Badge>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="manual-courier-name">Courier</Label>
              <Input
                id="manual-courier-name"
                value={courierName}
                onChange={(event) => setCourierName(event.target.value)}
                disabled={mutation.isPending}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="manual-tracking-id">Tracking ID</Label>
              <Input
                id="manual-tracking-id"
                value={trackingId}
                onChange={(event) => setTrackingId(event.target.value)}
                disabled={mutation.isPending}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="manual-tracking-url">Tracking URL</Label>
              <Input
                id="manual-tracking-url"
                type="url"
                value={trackingUrl}
                onChange={(event) => setTrackingUrl(event.target.value)}
                disabled={mutation.isPending}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="manual-shipment-amount">Shipment amount</Label>
              <Input
                id="manual-shipment-amount"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={shipmentAmount}
                onChange={(event) => setShipmentAmount(event.target.value)}
                disabled={mutation.isPending}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="manual-shipment-note">Note</Label>
            <Textarea
              id="manual-shipment-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              disabled={mutation.isPending}
              className="min-h-20"
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                mutation.isPending ||
                selectedItemIds.length === 0 ||
                !canCreateShipment
              }
            >
              {mutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Create Fulfillment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
