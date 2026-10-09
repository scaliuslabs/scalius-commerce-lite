import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { NumberInput } from "~/components/ui/number-input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Textarea } from "~/components/ui/textarea";
import { formatNumber, useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { resourceMessages } from "~/i18n/resource";
import { orderErrorMessage, useReceiveOrderReturn } from "~/lib/api-mutations/orders";
import { inventoryQueryOptions, type InventoryMovement } from "~/lib/api-query-options/inventory";
import {
  hasSeveralLocations,
  inventoryLocationsQueryOptions,
  type InventoryLocation,
} from "~/lib/api-query-options/inventory-locations";
import {
  StableReturnCommandKey,
  getOutstandingReceiptQuantity,
  type OrderReturnDto,
  type OrderReturnLineDto,
} from "~/lib/order-return-workflow";
import type { OrderItem } from "../types";
import { createReturnCommandKey, getOrderItemName, clampQuantity } from "./shared";
import { Field, ReadOnlyValue } from "~/components/ui/field";

interface ReceiptDraft { received: number; restock: number }

/** What the merchant is expected to receive: every approved unit still out, all back in stock when tracked. */
export function defaultReceiptDraft(lines: readonly OrderReturnLineDto[]): Record<string, ReceiptDraft> {
  return Object.fromEntries(lines.map((line) => {
    const outstanding = getOutstandingReceiptQuantity(line);
    return [line.id, { received: outstanding, restock: line.inventoryTracked ? outstanding : 0 }];
  }));
}

/** A typed quantity as a whole number of at least 0; more than expected is kept so it can be flagged. */
function typedQuantity(value: number | null): number {
  return clampQuantity(value, Number.MAX_SAFE_INTEGER);
}

/**
 * Receipt lines for the API. A tracked item is split into back-in-stock and
 * damaged; an untracked item is only received, which the server records as
 * "not put back into stock" (never shown as damaged).
 */
export function buildReceiptLines(lines: readonly OrderReturnLineDto[], draft: Record<string, ReceiptDraft>) {
  return lines.flatMap((line) => {
    const current = draft[line.id] ?? { received: 0, restock: 0 };
    if (current.received <= 0) return [];
    const restock = line.inventoryTracked ? Math.min(current.restock, current.received) : 0;
    return [{
      lineId: line.id,
      receivedQuantity: current.received,
      restockQuantity: restock,
      damagedQuantity: current.received - restock,
    }];
  });
}

/** The restock choice that sends no location: the API returns units to where they were sent from. */
export const RESTOCK_WHERE_SENT_FROM = "sent-from";

/**
 * Where the return's units left from, when that is one active location: the
 * order's deduct movements name it (as the API resolves a restock without a
 * location). Null when unknown, mixed or archived.
 */
export function returnSentFromLocation(
  lines: readonly OrderReturnLineDto[],
  deducts: readonly Pick<InventoryMovement, "variantId" | "locationId">[] | undefined,
  locations: readonly InventoryLocation[],
): InventoryLocation | null {
  const variantIds = new Set(lines.flatMap((line) => (line.inventoryTracked && line.variantId ? [line.variantId] : [])));
  const ids = new Set((deducts ?? []).flatMap((movement) =>
    variantIds.has(movement.variantId) && movement.locationId ? [movement.locationId] : []));
  if (ids.size !== 1) return null;
  const [id] = ids;
  return locations.find((location) => location.id === id && location.status === "active") ?? null;
}

export function ReceiveReturnDialog({
  orderReturn,
  itemsById,
  open,
  onOpenChange,
}: {
  /** The return being acted on; the dialog stays mounted without one. */
  orderReturn: OrderReturnDto | null;
  itemsById: ReadonlyMap<string, OrderItem>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useMessages(orderDetailMessages);
  const r = useMessages(resourceMessages);
  // Pre-filled with what is expected back; the merchant lowers it for anything missing or damaged.
  const [draft, setDraft] = useState<Record<string, ReceiptDraft>>(() => defaultReceiptDraft(orderReturn?.lines ?? []));
  const [notes, setNotes] = useState("");
  const mutation = useReceiveOrderReturn();
  const commandKey = useRef(new StableReturnCommandKey(createReturnCommandKey));
  // With several locations the merchant picks where restocked units go; by
  // default they go back to where they were sent from.
  const [restockChoice, setRestockChoice] = useState(RESTOCK_WHERE_SENT_FROM);
  const { data: locations } = useQuery(inventoryLocationsQueryOptions());
  const tracked = orderReturn?.lines.some((line) => line.inventoryTracked && getOutstandingReceiptQuantity(line) > 0) ?? false;
  const pickLocation = tracked && hasSeveralLocations(locations);
  const deducts = useQuery({
    ...inventoryQueryOptions({
      section: "movements",
      movementOrderId: orderReturn?.orderId ?? "",
      movementType: "deducted",
      limit: 100,
    }),
    enabled: open && pickLocation && Boolean(orderReturn),
  }).data?.movements;
  if (!orderReturn) return <Dialog open={false} onOpenChange={onOpenChange} />;
  const activeLocations = locations?.filter((location) => location.status === "active") ?? [];
  const sentFrom = pickLocation ? returnSentFromLocation(orderReturn.lines, deducts, activeLocations) : null;
  const restockLocationId = pickLocation && activeLocations.some((location) => location.id === restockChoice)
    ? restockChoice
    : null;
  const lines = buildReceiptLines(orderReturn.lines, draft);
  const received = lines.reduce((sum, line) => sum + line.receivedQuantity, 0);
  const tooMany = orderReturn.lines.some((line) => {
    const current = draft[line.id];
    return current !== undefined && (current.received > getOutstandingReceiptQuantity(line) || current.restock > current.received);
  });

  const submit = () => {
    if (lines.length === 0 || tooMany || mutation.isPending) return;
    const intent = {
      expectedVersion: orderReturn.version,
      notes: notes.trim() || null,
      lines,
      // Omitted, the API restocks each unit where it was sent from.
      ...(restockLocationId ? { restockLocationId } : {}),
    };
    mutation.mutate(
      { orderId: orderReturn.orderId, returnId: orderReturn.id, commandKey: commandKey.current.get("receive", intent), ...intent },
      {
        onSuccess: () => {
          commandKey.current.clear();
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("returns.receiveTitle")}</DialogTitle>
          <DialogDescription>{t("returns.receiveHelp")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {mutation.isError ? <Alert variant="destructive"><AlertDescription>{orderErrorMessage(mutation.error)}</AlertDescription></Alert> : null}
          <ul className="divide-y rounded-lg border">
            {orderReturn.lines.map((line) => {
              const outstanding = getOutstandingReceiptQuantity(line);
              const current = draft[line.id] ?? { received: 0, restock: 0 };
              const name = getOrderItemName(itemsById.get(line.orderItemId));
              if (outstanding === 0) return null;
              const receivedError = current.received > outstanding ? t("returns.receiveTooMany", { count: outstanding }) : null;
              const restockError = !receivedError && current.restock > current.received ? t("returns.restockTooMany") : null;
              const errorId = `receipt-${line.id}-error`;
              // Back in stock follows Received until the merchant sets it apart.
              const setReceived = (value: number | null) => {
                const next = typedQuantity(value);
                setDraft((existing) => {
                  const previous = existing[line.id] ?? { received: 0, restock: 0 };
                  const restock = !line.inventoryTracked ? 0
                    : previous.restock === previous.received ? Math.min(next, outstanding) : Math.min(previous.restock, next);
                  return { ...existing, [line.id]: { received: next, restock } };
                });
              };
              return (
                <li key={line.id} className="space-y-2 px-3 py-2 text-body">
                  <div>
                    <p className="font-medium">{name}</p>
                    <p className="text-muted-foreground">
                      {t("returns.awaiting", { count: outstanding })}
                      {line.inventoryTracked ? "" : ` · ${t("returns.untracked")}`}
                    </p>
                  </div>
                  {line.inventoryTracked ? (
                    <div className="grid grid-cols-3 gap-3">
                      <Field id={`${line.id}-received`} label={t("returns.received")}>
                        <NumberInput
                          integer
                          aria-label={t("returns.receivedQty", { name })}
                          aria-invalid={Boolean(receivedError) || undefined}
                          aria-describedby={receivedError ? errorId : undefined}
                          value={current.received}
                          disabled={mutation.isPending}
                          onValueChange={setReceived}
                        />
                      </Field>
                      <Field id={`${line.id}-restock`} label={t("returns.restock")}>
                        <NumberInput
                          integer
                          aria-label={t("returns.restockQty", { name })}
                          aria-invalid={Boolean(restockError) || undefined}
                          aria-describedby={restockError ? errorId : undefined}
                          disabled={current.received === 0 || mutation.isPending}
                          value={current.restock}
                          onValueChange={(value) => setDraft((existing) => ({
                            ...existing,
                            [line.id]: { ...current, restock: typedQuantity(value) },
                          }))}
                        />
                      </Field>
                      {/* Derived from valid quantities only: nothing to show next to an error (R3-ORD-16). */}
                      <ReadOnlyValue
                        besideControls
                        numeric
                        label={t("returns.damaged")}
                        value={receivedError || restockError ? null : (
                          <span aria-label={t("returns.damagedQty", { count: current.received - current.restock })}>
                            {formatNumber(current.received - current.restock)}
                          </span>
                        )}
                      />
                    </div>
                  ) : (
                    <Field id={`${line.id}-received`} label={t("returns.received")} className="max-w-40">
                      <NumberInput
                        integer
                        aria-label={t("returns.receivedQty", { name })}
                        aria-invalid={Boolean(receivedError) || undefined}
                        aria-describedby={receivedError ? errorId : undefined}
                        value={current.received}
                        disabled={mutation.isPending}
                        onValueChange={setReceived}
                      />
                    </Field>
                  )}
                  {receivedError || restockError ? <p id={errorId} className="text-destructive">{receivedError ?? restockError}</p> : null}
                </li>
              );
            })}
          </ul>
          {pickLocation ? (
            <Field id={`receipt-location-${orderReturn.id}`} label={t("returns.restockAt")}>
              <SearchableSelect
                id={`receipt-location-${orderReturn.id}`}
                triggerClassName="w-full"
                disabled={mutation.isPending}
                value={restockLocationId ?? RESTOCK_WHERE_SENT_FROM}
                onValueChange={setRestockChoice}
                options={[
                  {
                    value: RESTOCK_WHERE_SENT_FROM,
                    label: sentFrom ? t("returns.restockSentFromNamed", { name: sentFrom.name }) : t("returns.restockSentFrom"),
                  },
                  ...activeLocations
                    .filter((location) => location.id !== sentFrom?.id)
                    .map((location) => ({
                      value: location.id,
                      label: location.isDefault ? t("location.default", { name: location.name }) : location.name,
                    })),
                ]}
              />
            </Field>
          ) : null}
          <Field id={`receipt-notes-${orderReturn.id}`} label={t("returns.notes")}>
            <Textarea id={`receipt-notes-${orderReturn.id}`} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
          </Field>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>{r("cancel")}</Button>
          <Button type="button" onClick={submit} disabled={lines.length === 0 || tooMany} loading={mutation.isPending}>
            {received > 0 && !tooMany ? t("returns.receiveCount", { count: received }) : t("returns.receiveSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
