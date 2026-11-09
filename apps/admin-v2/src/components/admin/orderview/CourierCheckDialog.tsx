import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Field, FieldRow } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Textarea } from "~/components/ui/textarea";
import { useMessages } from "~/i18n";
import { orderCourierCheckMessages } from "~/i18n/order-courier-check";
import { resourceMessages } from "~/i18n/resource";
import { orderErrorMessage, useResolveUnknownShipment } from "~/lib/api-mutations/orders";
import { courierName } from "./ShipmentCard";
import type { Order } from "./types";

type Outcome = "confirmed_existing" | "confirmed_not_created" | "confirmed_cancelled";
type EvidenceSource = "courier_portal" | "courier_support";
const OUTCOMES: Outcome[] = ["confirmed_existing", "confirmed_not_created", "confirmed_cancelled"];
const EVIDENCE_SOURCES: EvidenceSource[] = ["courier_portal", "courier_support"];

/**
 * The courier may or may not have booked this order. The merchant must check
 * the courier account and confirm before anything can be booked again.
 */
export function CourierCheckDialog({
  order,
  shipmentId,
  open,
  onOpenChange,
}: {
  order: Order;
  shipmentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useMessages(orderCourierCheckMessages);
  const r = useMessages(resourceMessages);
  const mutation = useResolveUnknownShipment();
  const [outcome, setOutcome] = useState<Outcome>("confirmed_existing");
  const [evidenceSource, setEvidenceSource] = useState<EvidenceSource>("courier_portal");
  const [evidenceNote, setEvidenceNote] = useState("");
  const [externalId, setExternalId] = useState("");
  const [trackingId, setTrackingId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const operationKey = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setOutcome("confirmed_existing");
    setEvidenceSource("courier_portal");
    setEvidenceNote("");
    setExternalId("");
    setTrackingId("");
    setConfirmed(false);
    operationKey.current = null;
    mutation.reset();
    // Every opening starts clean.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Any edit after ticking the box needs a fresh confirmation and key.
  const edited = () => {
    setConfirmed(false);
    operationKey.current = null;
  };
  const close = () => {
    operationKey.current = null;
    onOpenChange(false);
  };
  // "Not created" and "cancelled" rest on the staff's own search of the
  // courier (a lookup can only veto them), so the note names the order ID searched.
  const needsOrderNumber = outcome !== "confirmed_existing";
  const ready = confirmed
    && evidenceNote.trim().length >= 8
    && (!needsOrderNumber || evidenceNote.toLowerCase().includes(order.id.toLowerCase()))
    && (outcome !== "confirmed_existing" || externalId.trim().length > 0);
  const submit = () => {
    if (!ready) return;
    operationKey.current ??= crypto.randomUUID();
    mutation.mutate({
      orderId: order.id,
      shipmentId,
      expectedOrderVersion: order.version,
      operationKey: operationKey.current,
      outcome,
      evidenceSource,
      evidenceNote: evidenceNote.trim(),
      confirmationAccepted: true,
      ...(outcome === "confirmed_existing"
        ? { externalId: externalId.trim(), ...(trackingId.trim() ? { trackingId: trackingId.trim() } : {}) }
        : {}),
    }, { onSuccess: close });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("courier.checkTitle")}</DialogTitle>
          <DialogDescription>{t("courier.checkHelp", { courier: courierName(order, order.shipmentRecovery?.providerType) })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field id="courier-outcome" label={t("courier.outcome")}>
            <SearchableSelect
              triggerClassName="w-full"
              id="courier-outcome"
              disabled={mutation.isPending}
              value={outcome}
              onValueChange={(value) => { setOutcome(value as Outcome); edited(); }}
              options={OUTCOMES.map((value) => ({ value, label: t(`courier.outcome.${value}`) }))}
            />
          </Field>
          {outcome === "confirmed_existing" ? (
            <FieldRow>
              <Field id="courier-consignment" label={t("courier.consignmentId")}>
                <Input id="courier-consignment" value={externalId} maxLength={180} disabled={mutation.isPending} onChange={(e) => { setExternalId(e.target.value); edited(); }} />
              </Field>
              <Field id="courier-tracking" label={t("shipments.trackingId")}>
                <Input id="courier-tracking" value={trackingId} maxLength={180} disabled={mutation.isPending} onChange={(e) => { setTrackingId(e.target.value); edited(); }} />
              </Field>
            </FieldRow>
          ) : null}
          <Field id="courier-source" label={t("courier.source")}>
            <SearchableSelect
              triggerClassName="w-full"
              id="courier-source"
              disabled={mutation.isPending}
              value={evidenceSource}
              onValueChange={(value) => { setEvidenceSource(value as EvidenceSource); edited(); }}
              options={EVIDENCE_SOURCES.map((value) => ({ value, label: t(`courier.source.${value}`) }))}
            />
          </Field>
          <Field
            id="courier-evidence"
            label={t("courier.details")}
            help={needsOrderNumber ? t("courier.notCreatedEvidence", { order: order.id }) : undefined}
          >
            <Textarea
              id="courier-evidence"
              value={evidenceNote}
              maxLength={500}
              disabled={mutation.isPending}
              placeholder={t("courier.detailsPlaceholder")}
              onChange={(e) => { setEvidenceNote(e.target.value); edited(); }}
            />
          </Field>
          {mutation.isError ? <p role="alert" className="text-destructive">{orderErrorMessage(mutation.error)}</p> : null}
          <div className="flex items-start gap-3">
            <span className="flex h-5 items-center">
              <Checkbox id="courier-confirmed" checked={confirmed} disabled={mutation.isPending} onCheckedChange={(value) => setConfirmed(value === true)} />
            </span>
            <Label htmlFor="courier-confirmed">{t("courier.confirm")}</Label>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} disabled={mutation.isPending}>{r("cancel")}</Button>
          <Button type="button" onClick={submit} loading={mutation.isPending} disabled={!ready}>
            {r("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
