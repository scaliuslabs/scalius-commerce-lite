// "Ships from <location>" on an order's unfulfilled physical card, with a
// Change action until anything has left (Shopify's "Change location"). A
// store with one location never sees it: every order ships from there.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { useSetOrderFulfillmentLocation } from "~/lib/api-mutations/orders";
import { hasSeveralLocations, inventoryLocationsQueryOptions } from "~/lib/api-query-options/inventory-locations";
import type { Order } from "./types";

export function OrderFulfillmentLocation({ order }: { order: Order }) {
  const t = useMessages(orderDetailMessages);
  const permissions = useOrderActionPermissions();
  const { data: locations } = useQuery(inventoryLocationsQueryOptions());
  const [open, setOpen] = useState(false);
  const current = order.fulfillmentLocation;
  const active = locations?.filter((location) => location.status === "active") ?? [];
  const [choice, setChoice] = useState(current?.id ?? "");
  const save = useSetOrderFulfillmentLocation();

  if (!current || !hasSeveralLocations(locations)) return null;
  const canChange = permissions.canEditOrders && order.editReadiness.details.allowed;
  const label = (location: { name: string; isDefault: boolean }) =>
    location.isDefault ? t("location.default", { name: location.name }) : location.name;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
      <p className="text-body text-muted-foreground">{t("location.shipsFrom", { name: current.name })}</p>
      {canChange ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={() => {
            setChoice(current.id);
            setOpen(true);
          }}
        >
          {t("location.change")}
        </Button>
      ) : null}
      <Dialog open={open} onOpenChange={(next) => (save.isPending ? undefined : setOpen(next))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("location.dialogTitle")}</DialogTitle>
            <DialogDescription>{t("location.dialogHelp")}</DialogDescription>
          </DialogHeader>
          <form
            id="order-fulfillment-location-form"
            method="post"
            noValidate
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (save.isPending || !choice) return;
              if (choice === current.id) {
                setOpen(false);
                return;
              }
              save.mutate(
                { orderId: order.id, locationId: choice, expectedVersion: order.version },
                { onSuccess: () => setOpen(false) },
              );
            }}
          >
            <Field id="order-fulfillment-location" label={t("location.label")}>
              <SearchableSelect
              triggerClassName="w-full"
              value={choice}
              onValueChange={(value) => {
                if (active.some((location) => location.id === value)) setChoice(value);
              }}
              options={active.map((location) => ({ value: location.id, label: label(location) }))}
              />
            </Field>
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={save.isPending} onClick={() => setOpen(false)}>
              {t("location.cancel")}
            </Button>
            <Button type="submit" form="order-fulfillment-location-form" loading={save.isPending}>
              {t("location.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
