import { PresenceSlot, presenceKey } from "~/lib/realtime/store";
import { ReadOnlyNotice } from "~/components/admin/states/ReadOnlyNotice";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "~/lib/toast";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Progress } from "~/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { useIsMobile } from "~/hooks/use-mobile";
import { formatNumber, useMessages } from "~/i18n";
import { purchasingMessages } from "~/i18n/purchasing";
import { useTransferCommand, type Transfer } from "~/lib/api-query-options/purchasing";
import { useOperationKeys } from "./operation-key";
import { formatDay, formatMoment, lineName } from "./purchasing-format";
import { PurchasingProblemBanner, readPurchasingProblem, type PurchasingProblem } from "./purchasing-problem";
import { isOpenTransfer, TransferStatusBadge } from "./purchasing-status";
import { Fact, LineProduct, useUnitsText } from "./purchasing-ui";
import { Page } from "~/components/admin/resource/Page";
import { PurchasingLines } from "./PurchasingLines";

/**
 * A transfer once shipped (or a draft for staff who can't edit): what left,
 * what arrived and what is still on the road, with its activity. Receive and
 * Cancel act on it; cancelling sends what is in transit back to the origin.
 */
export function TransferDetail({ transfer, onReload }: { transfer: Transfer; onReload: () => Promise<void> }) {
  const t = useMessages(purchasingMessages);
  const { inventory: { canManageOperations: canEdit } } = useCatalogActionPermissions();
  const unitsText = useUnitsText();
  const command = useTransferCommand();
  const keys = useOperationKeys();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [problem, setProblem] = useState<PurchasingProblem | null>(null);
  const [reloading, setReloading] = useState(false);
  const open = isOpenTransfer(transfer.status);
  const shipped = transfer.lines.reduce((sum, line) => sum + line.shippedQuantity, 0);
  const progress = shipped > 0 ? Math.round((transfer.receivedQuantity / shipped) * 100) : 0;

  const cancel = () => {
    const operationKey = keys.keyFor(JSON.stringify({ action: "cancel", id: transfer.id, revision: transfer.revision }));
    command.mutate({ id: transfer.id, revision: transfer.revision, operationKey, action: "cancel" }, {
      onSuccess: () => {
        keys.reset();
        setConfirmCancel(false);
        setProblem(null);
        toast.success(t("transferCancelled"));
      },
      onError: (error) => {
        setConfirmCancel(false);
        setProblem(readPurchasingProblem(error));
      },
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
      <PageHeader
        presence={<PresenceSlot presenceKey={presenceKey("transfer", transfer.id)} revision={transfer.revision} dirty={false} readOnly={!canEdit} />}
        backTo="/admin/inventory/transfers"
        title={transfer.displayNumber}
        status={<TransferStatusBadge status={transfer.status} />}
        actions={canEdit && open ? (
          <>
            <Button type="button" variant="outline" disabled={command.isPending} onClick={() => setConfirmCancel(true)}>
              {t("cancelTransfer")}
            </Button>
            <Button asChild>
              <Link to="/admin/inventory/transfers/$transferId/receive" params={{ transferId: transfer.id }}>{t("receive")}</Link>
            </Button>
          </>
        ) : null}
      />
      {!canEdit ? (
        <ReadOnlyNotice />
      ) : null}
      {problem ? (
        <div className="mb-4">
          <PurchasingProblemBanner
            problem={problem}
            staleText={t("transferChanged")}
            failedText={t("cancelFailed")}
            onReload={() => void reload()}
            reloading={reloading}
          />
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Card>
            <CardHeader className="gap-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <CardTitle>{t("products")}</CardTitle>
                {shipped > 0 ? (
                  <span className="text-body text-muted-foreground tabular-nums">
                    {t("receivedProgress", { received: transfer.receivedQuantity, total: shipped })}
                  </span>
                ) : null}
              </div>
              {shipped > 0 ? (
                <Progress value={progress} aria-label={t("receivedProgress", { received: transfer.receivedQuantity, total: shipped })} />
              ) : null}
            </CardHeader>
            <TransferLines transfer={transfer} />
          </Card>
          <ActivityCard transfer={transfer} />
        </div>

        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t("details")}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-3">
                <Fact label={t("origin")}>{transfer.origin.name}</Fact>
                <Fact label={t("destination")}>{transfer.destination.name}</Fact>
                <Fact label={t("expectedArrival")}>{formatDay(transfer.expectedOn) ?? t("notSet")}</Fact>
                <Fact label={t("reference")}>{transfer.reference ?? t("none")}</Fact>
                <Fact label={t("createdOn")}>{formatMoment(transfer.createdAt) ?? "—"}</Fact>
                {transfer.shippedAt ? <Fact label={t("shippedOn")}>{formatMoment(transfer.shippedAt)}</Fact> : null}
                {transfer.receivedAt ? <Fact label={t("receivedOn")}>{formatMoment(transfer.receivedAt)}</Fact> : null}
                {transfer.cancelledAt ? <Fact label={t("cancelledOn")}>{formatMoment(transfer.cancelledAt)}</Fact> : null}
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("colInTransit")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-heading-lg tabular-nums">{unitsText(transfer.inTransitQuantity)}</p>
              <p className="text-body text-muted-foreground">{t("inTransitHelp")}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("notes")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className={transfer.notes ? "whitespace-pre-wrap break-words text-body" : "text-body text-muted-foreground"}>
                {transfer.notes ?? t("none")}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={confirmCancel && canEdit}
        onOpenChange={(next) => { if (!next && !command.isPending) setConfirmCancel(false); }}
        title={t("cancelTransferTitle", { number: transfer.displayNumber })}
        description={transfer.status === "draft"
          ? t("cancelDraftBody")
          : t("cancelInTransitBody", {
            units: unitsText(transfer.inTransitQuantity),
            origin: transfer.origin.name,
            destination: transfer.destination.name,
          })}
        confirmLabel={t("cancelTransfer")}
        cancelLabel={t("keepTransfer")}
        isLoading={command.isPending}
        onConfirm={cancel}
      />
    </Page>
  );
}

/** Per line: ordered, shipped, received, in transit (and returned once any came back). */
function TransferLines({ transfer }: { transfer: Transfer }) {
  const t = useMessages(purchasingMessages);
  const isMobile = useIsMobile();
  const returned = transfer.returnedQuantity > 0;
  return (
    <PurchasingLines lines={transfer.lines}>{(pageLines) => isMobile ? (
      <ul className="divide-y border-t">
        {pageLines.map((line) => (
          <li key={line.id} data-purchasing-line={line.variantId} className="space-y-1 px-4 py-3">
            <LineProduct line={line} retired={line.retired} />
            <dl className="flex flex-wrap gap-x-4 gap-y-1 text-body tabular-nums">
              <div className="flex gap-1"><dt className="text-muted-foreground">{t("colQuantity")}</dt><dd>{formatNumber(line.quantity)}</dd></div>
              <div className="flex gap-1"><dt className="text-muted-foreground">{t("colReceived")}</dt><dd>{formatNumber(line.receivedQuantity)}</dd></div>
              <div className="flex gap-1"><dt className="text-muted-foreground">{t("colInTransit")}</dt><dd>{formatNumber(line.inTransitQuantity)}</dd></div>
              {returned ? (
                <div className="flex gap-1"><dt className="text-muted-foreground">{t("colReturned")}</dt><dd>{formatNumber(line.returnedQuantity)}</dd></div>
              ) : null}
            </dl>
          </li>
        ))}
      </ul>
    ) : (
    <div className="border-t">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("colProduct")}</TableHead>
            <TableHead data-numeric="">{t("colQuantity")}</TableHead>
            <TableHead data-numeric="">{t("colShipped")}</TableHead>
            <TableHead data-numeric="">{t("colReceived")}</TableHead>
            <TableHead data-numeric="">{t("colInTransit")}</TableHead>
            {returned ? <TableHead data-numeric="">{t("colReturned")}</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {pageLines.map((line) => (
            <TableRow key={line.id} data-purchasing-line={line.variantId}>
              <TableCell className="py-2"><LineProduct line={line} retired={line.retired} /></TableCell>
              <TableCell data-numeric="">{formatNumber(line.quantity)}</TableCell>
              <TableCell data-numeric="">{formatNumber(line.shippedQuantity)}</TableCell>
              <TableCell data-numeric="">{formatNumber(line.receivedQuantity)}</TableCell>
              <TableCell data-numeric="">{formatNumber(line.inTransitQuantity)}</TableCell>
              {returned ? <TableCell data-numeric="">{formatNumber(line.returnedQuantity)}</TableCell> : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
    )}</PurchasingLines>
  );
}

/** Ship, receive and return events, newest first. */
function ActivityCard({ transfer }: { transfer: Transfer }) {
  const t = useMessages(purchasingMessages);
  const unitsText = useUnitsText();
  const lines = new Map(transfer.lines.map((line) => [line.id, line]));
  const locationName = (id: string) =>
    id === transfer.origin.id ? transfer.origin.name : id === transfer.destination.id ? transfer.destination.name : "";
  const activity = [...transfer.activity].reverse();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("activity")}</CardTitle>
      </CardHeader>
      {activity.length === 0 ? (
        <CardContent><p className="text-body text-muted-foreground">{t("noActivity")}</p></CardContent>
      ) : (
        <ul className="divide-y border-t">
          {activity.map((event) => {
            const units = event.lines.reduce((sum, line) => sum + line.quantity, 0);
            const location = locationName(event.lines[0]?.locationId ?? "");
            return (
              <li key={`${event.kind}:${event.operationKey}`} className="space-y-1 px-4 py-3">
                <p className="flex flex-wrap items-baseline justify-between gap-x-4 text-body">
                  <span className="font-medium">{t(`activity_${event.kind}`, { location })}</span>
                  <span className="tabular-nums text-muted-foreground">{unitsText(units)}</span>
                </p>
                <p className="text-body text-muted-foreground">
                  {t("receiptBy", { date: formatMoment(event.createdAt) ?? "—", name: event.actorName })}
                </p>
                <ul className="space-y-0.5">
                  {event.lines.map((entry) => {
                    const line = lines.get(entry.lineId);
                    return (
                      <li key={entry.lineId} className="flex flex-wrap items-baseline justify-between gap-x-4 text-body">
                        <span className="min-w-0">
                          {line ? lineName(line, t("unknownProduct")) : null}{" "}
                          <span className="font-mono text-muted-foreground">{entry.sku}</span>
                        </span>
                        <span className="tabular-nums">{formatNumber(entry.quantity)}</span>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
