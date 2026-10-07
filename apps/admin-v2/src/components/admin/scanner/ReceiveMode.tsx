// Scanner "Receive" mode: pick an open purchase order or a transfer on its
// way, count what arrived by scanning (or with − / +), then book it with one
// receive command. Counting is local and instant; only the final tap writes.
// The session state lives in ScannerApp (`useReceiveSession`), so opening the
// history or another mode never loses a count.
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Minus, Plus, RefreshCw } from "lucide-react";
import {
  getApiV1AdminInventoryPurchaseOrders,
  getApiV1AdminInventoryPurchaseOrdersByPurchaseOrderId,
  getApiV1AdminInventoryTransfers,
  getApiV1AdminInventoryTransfersByTransferId,
  postApiV1AdminInventoryPurchaseOrdersByPurchaseOrderIdReceive,
  postApiV1AdminInventoryTransfersByTransferIdReceive,
} from "@scalius/api-client/sdk";
import { apiData } from "@/lib/api";
import { AdminApiResponseError } from "@/lib/admin-api-error";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { cn } from "@scalius/shared/utils";
import { translate, useMessages } from "~/i18n";
import { scannerMessages } from "~/i18n/scanner";
import { BarcodeScanner } from "./BarcodeScanner";
import type { FlashState } from "./ScanFlash";
import {
  clampTally,
  countedTotal,
  createIntentKeys,
  receiveFingerprint,
  receiveLines,
  setCounted,
  tallyScan,
  type ReceiveLine,
  type ReceiveTally,
} from "./receive-tally";

const tr = (key: keyof typeof scannerMessages.en, vars?: Record<string, string | number>) =>
  translate(scannerMessages, key, vars);

export type ReceiveKind = "purchaseOrder" | "transfer";

/** An open purchase order or transfer to pick. */
export interface ReceiveChoice {
  kind: ReceiveKind;
  id: string;
  /** "PO1001" / "T1001". */
  number: string;
  /** The supplier, or "Origin → Destination"; null for a PO without a supplier. */
  title: string | null;
  destination: string;
  /** Units still to receive. */
  open: number;
}

/** The document being received, with the lines still open. */
export interface ReceiveDocument {
  kind: ReceiveKind;
  id: string;
  number: string;
  title: string | null;
  revision: number;
  lines: ReceiveLine[];
  /** Lines with nothing left to receive (not listed). */
  doneLines: number;
}

type Choices =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; purchaseOrders: ReceiveChoice[]; transfers: ReceiveChoice[] };

type Feedback = {
  flash: (state: FlashState) => void;
  beep: (type: "success" | "error" | "scan") => void;
  haptic: (type: "success" | "error" | "light" | "warning" | "selection" | "medium") => void;
};

async function fetchChoices(locationId: string | null): Promise<{ purchaseOrders: ReceiveChoice[]; transfers: ReceiveChoice[] }> {
  const at = locationId ? { locationId } : {};
  const [orders, transfers] = await Promise.all([
    apiData(getApiV1AdminInventoryPurchaseOrders({ query: { status: "open", limit: 50, ...at } })),
    apiData(getApiV1AdminInventoryTransfers({ query: { status: "open", limit: 50, ...at } })),
  ]);
  return {
    purchaseOrders: orders.purchaseOrders
      .map((order): ReceiveChoice => ({
        kind: "purchaseOrder",
        id: order.id,
        number: order.displayNumber,
        title: order.supplier?.name ?? null,
        destination: order.destination.name,
        open: Math.max(0, order.quantity - order.receivedQuantity),
      }))
      .filter((choice) => choice.open > 0),
    // `locationId` matches either end of a transfer: only those arriving here are received here.
    transfers: transfers.transfers
      .filter((transfer) => !locationId || transfer.destination.id === locationId)
      .map((transfer): ReceiveChoice => ({
        kind: "transfer",
        id: transfer.id,
        number: transfer.displayNumber,
        title: tr("route", { from: transfer.origin.name, to: transfer.destination.name }),
        destination: transfer.destination.name,
        open: transfer.inTransitQuantity,
      }))
      .filter((choice) => choice.open > 0),
  };
}

export async function fetchReceiveDocument(kind: ReceiveKind, id: string): Promise<ReceiveDocument> {
  if (kind === "purchaseOrder") {
    const order = await apiData(getApiV1AdminInventoryPurchaseOrdersByPurchaseOrderId({ path: { purchaseOrderId: id } }));
    const lines = order.lines.map((line): ReceiveLine => ({
      id: line.id,
      sku: line.sku,
      barcode: line.barcode,
      productName: line.productName,
      optionLabel: line.optionLabel,
      open: line.openQuantity,
      // A purchase order books only live SKUs.
      blocked: line.retired,
    }));
    return {
      kind,
      id,
      number: order.displayNumber,
      title: order.supplier?.name ?? null,
      revision: order.revision,
      lines: lines.filter((line) => line.open > 0),
      doneLines: lines.filter((line) => line.open <= 0).length,
    };
  }
  const transfer = await apiData(getApiV1AdminInventoryTransfersByTransferId({ path: { transferId: id } }));
  // Units already on the road arrive even if their SKU was retired meanwhile.
  const lines = transfer.lines.map((line): ReceiveLine => ({
    id: line.id,
    sku: line.sku,
    barcode: line.barcode,
    productName: line.productName,
    optionLabel: line.optionLabel,
    open: line.inTransitQuantity,
  }));
  return {
    kind,
    id,
    number: transfer.displayNumber,
    title: tr("route", { from: transfer.origin.name, to: transfer.destination.name }),
    revision: transfer.revision,
    lines: lines.filter((line) => line.open > 0),
    doneLines: lines.filter((line) => line.open <= 0).length,
  };
}

/** A receive command; retried once with the same key unless the API refused it. */
async function postReceive(
  receiving: ReceiveDocument,
  lines: Array<{ lineId: string; quantity: number }>,
  updateCost: boolean,
  operationKey: string,
) {
  const send = () => receiving.kind === "purchaseOrder"
    ? apiData(postApiV1AdminInventoryPurchaseOrdersByPurchaseOrderIdReceive({
      path: { purchaseOrderId: receiving.id },
      body: { operationKey, lines, updateCost },
    }))
    : apiData(postApiV1AdminInventoryTransfersByTransferIdReceive({
      path: { transferId: receiving.id },
      body: { operationKey, lines },
    }));
  try {
    return await send();
  } catch (error) {
    if (error instanceof AdminApiResponseError && error.status < 500) throw error;
    return send();
  }
}

/** The receive session: kept by ScannerApp so history and other modes never lose a count. */
export function useReceiveSession({ locationId, feedback, onReceived }: {
  /** Where this device receives (several locations), else null. */
  locationId: string | null;
  feedback: Feedback;
  /** A receipt was booked: the scanner's history records it. */
  onReceived: (receipt: { number: string; title: string | null; units: number }) => void;
}) {
  const [choices, setChoices] = useState<Choices>({ status: "loading" });
  const [receiving, setReceiving] = useState<ReceiveDocument | null>(null);
  const [opening, setOpening] = useState<ReceiveChoice | null>(null);
  const [openFailed, setOpenFailed] = useState(false);
  const [tally, setTallyState] = useState<ReceiveTally>({});
  // Scans can arrive faster than renders (a keyboard-wedge scanner): count from the latest tally.
  const tallyRef = useRef<ReceiveTally>({});
  const receivingRef = useRef<ReceiveDocument | null>(null);
  receivingRef.current = receiving;
  const [updateCost, setUpdateCost] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [keys] = useState(() => createIntentKeys());

  const setTally = useCallback((next: ReceiveTally) => {
    tallyRef.current = next;
    setTallyState(next);
  }, []);

  const loadChoices = useCallback(async () => {
    setChoices({ status: "loading" });
    try {
      setChoices({ status: "ready", ...(await fetchChoices(locationId)) });
    } catch {
      setChoices({ status: "failed" });
    }
  }, [locationId]);

  const open = useCallback(async (choice: ReceiveChoice) => {
    setOpening(choice);
    setOpenFailed(false);
    setNotice(null);
    try {
      const loaded = await fetchReceiveDocument(choice.kind, choice.id);
      setReceiving(loaded);
      setTally({});
      setUpdateCost(false);
      setProblem(null);
      keys.settle();
      setOpening(null);
    } catch {
      setOpenFailed(true);
    }
  }, [keys, setTally]);

  // Back to the list (which reloads as it opens).
  const close = useCallback(() => {
    setReceiving(null);
    setOpening(null);
    setOpenFailed(false);
    setTally({});
    setProblem(null);
    keys.settle();
  }, [keys, setTally]);

  /** One scanned unit: counted on its line, or why not. */
  const scan = useCallback((code: string) => {
    const current = receivingRef.current;
    if (!current || submittingRef.current) return;
    const { tally: next, outcome } = tallyScan(current.lines, tallyRef.current, code);
    if (outcome.kind === "counted") {
      setTally(next);
      setProblem(null);
      feedback.flash({
        type: "success",
        action: tr("counted"),
        productName: outcome.line.productName ?? outcome.line.sku,
        detail: tr("countedOf", { counted: outcome.counted, open: outcome.line.open }),
      });
      feedback.beep("success");
      feedback.haptic("success");
      return;
    }
    feedback.flash(outcome.kind === "unknown"
      ? { type: "error", barcode: code, title: tr(current.kind === "purchaseOrder" ? "notOnPurchaseOrder" : "notOnTransfer") }
      : outcome.kind === "full"
        ? { type: "error", barcode: code, title: tr("allCounted"), detail: tr("allCountedDetail", { sku: outcome.line.sku, count: outcome.line.open }) }
        : { type: "error", barcode: code, title: tr("cantReceive"), detail: tr("lineRetired") });
    feedback.beep("error");
    feedback.haptic(outcome.kind === "unknown" ? "error" : "warning");
  }, [feedback, setTally]);

  const setLineCount = useCallback((lineId: string, count: number) => {
    const current = receivingRef.current;
    if (!current || submittingRef.current) return;
    setTally(setCounted(current.lines, tallyRef.current, lineId, count));
    setProblem(null);
    feedback.haptic("light");
  }, [feedback, setTally]);

  const submit = useCallback(async () => {
    const current = receivingRef.current;
    const lines = current ? receiveLines(current.lines, tallyRef.current) : [];
    if (!current || lines.length === 0 || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setProblem(null);
    const withCost = current.kind === "purchaseOrder" && updateCost;
    const operationKey = keys.keyFor(receiveFingerprint({
      kind: current.kind,
      documentId: current.id,
      revision: current.revision,
      lines,
      updateCost: withCost,
    }));
    try {
      await postReceive(current, lines, withCost, operationKey);
      keys.settle();
      const units = lines.reduce((total, line) => total + line.quantity, 0);
      setTally({});
      onReceived({ number: current.number, title: current.title, units });
      feedback.flash({
        type: "success",
        action: tr("receivedOn", { count: units, number: current.number }),
        productName: current.title ?? "",
      });
      feedback.beep("success");
      feedback.haptic("success");
      let latest: ReceiveDocument;
      try {
        latest = await fetchReceiveDocument(current.kind, current.id);
      } catch {
        // Couldn't reload: what was booked is no longer open.
        const booked = new Map(lines.map((line) => [line.lineId, line.quantity]));
        const remaining = current.lines.map((line) => ({ ...line, open: line.open - (booked.get(line.id) ?? 0) }));
        latest = {
          ...current,
          lines: remaining.filter((line) => line.open > 0),
          doneLines: current.doneLines + remaining.filter((line) => line.open <= 0).length,
        };
      }
      if (latest.lines.every((line) => line.blocked)) {
        // Nothing left to receive: back to the list (it reloads), saying so.
        setReceiving(null);
        setNotice(tr("documentDone", { number: current.number }));
      } else {
        setReceiving(latest);
      }
    } catch (error) {
      if (error instanceof AdminApiResponseError && error.status < 500) {
        // Refused: nothing was booked. Changed meanwhile (another receipt, a cancel): reload and keep what still fits.
        keys.settle();
        if (error.status === 409 || error.status === 404) {
          try {
            const latest = await fetchReceiveDocument(current.kind, current.id);
            setReceiving(latest);
            setTally(clampTally(latest.lines, tallyRef.current));
          } catch {
            // The message still says to try again.
          }
          setProblem(tr("receiveChanged", { number: current.number }));
        } else {
          setProblem(tr("receiveFailed"));
        }
      } else {
        // Unknown outcome: the same tap again reuses the key, so it can't book twice.
        setProblem(tr("receiveNotSaved"));
      }
      feedback.beep("error");
      feedback.haptic("error");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [feedback, keys, onReceived, setTally, updateCost]);

  return {
    choices,
    loadChoices,
    receiving,
    opening,
    openFailed,
    open,
    close,
    tally,
    scan,
    setLineCount,
    updateCost,
    setUpdateCost,
    submitting,
    submit,
    problem,
    notice,
  };
}

export type ReceiveSession = ReturnType<typeof useReceiveSession>;

const ROW_BUTTON = "flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted active:bg-accent disabled:opacity-40";

/** The receive screen: the list of open documents, or the chosen one with its camera and lines. */
export function ReceiveMode({ session, showDestination }: {
  session: ReceiveSession;
  /** The store has several locations and the list isn't narrowed to one: name each destination. */
  showDestination: boolean;
}) {
  const t = useMessages(scannerMessages);
  const { receiving, loadChoices } = session;
  const [confirmLeave, setConfirmLeave] = useState(false);

  // Each visit to the list starts fresh.
  useEffect(() => {
    if (!receiving) void loadChoices();
  }, [receiving, loadChoices]);
  useEffect(() => {
    if (!confirmLeave) return;
    const timer = setTimeout(() => setConfirmLeave(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmLeave]);

  if (!receiving) return <ChoiceList session={session} showDestination={showDestination} />;

  const counted = countedTotal(session.tally);
  const leave = () => {
    if (counted > 0 && !confirmLeave) {
      setConfirmLeave(true);
      return;
    }
    setConfirmLeave(false);
    session.close();
  };

  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b bg-card px-3 py-2">
        <div className="min-w-0">
          <p className="font-mono text-body font-semibold">{receiving.number}</p>
          <p className="truncate text-body text-muted-foreground">{receiving.title ?? t("noSupplier")}</p>
        </div>
        <button
          type="button"
          onClick={leave}
          className={cn(
            "flex h-11 shrink-0 items-center rounded-lg px-3 text-body font-medium active:bg-accent",
            confirmLeave ? "bg-destructive/15 text-destructive" : "bg-muted",
          )}
        >
          {confirmLeave ? t("discardCount", { count: counted }) : t("change")}
        </button>
      </div>

      <div className="relative h-40 shrink-0">
        <BarcodeScanner onScan={(code) => session.scan(code)} isActive showTorchButton />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul className="divide-y">
          {receiving.lines.map((line) => {
            const lineCount = session.tally[line.id] ?? 0;
            const name = [line.productName ?? line.sku, line.optionLabel].filter(Boolean).join(" · ");
            return (
              <li key={line.id} className={cn("flex items-center gap-3 px-4 py-2", lineCount > 0 && "bg-accent")}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body font-medium">{line.productName ?? line.sku}</p>
                  <p className="truncate text-body text-muted-foreground">
                    {line.optionLabel ? `${line.optionLabel} · ` : null}
                    <span className="font-mono">{line.sku}</span>
                  </p>
                  {line.blocked ? <p className="text-body text-destructive">{t("lineRetired")}</p> : null}
                </div>
                {line.blocked ? null : (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      className={ROW_BUTTON}
                      disabled={lineCount === 0 || session.submitting}
                      aria-label={t("oneLess", { name })}
                      onClick={() => session.setLineCount(line.id, lineCount - 1)}
                    >
                      <Minus className="size-4" />
                    </button>
                    <button
                      type="button"
                      className="h-11 min-w-16 rounded-lg px-1 text-center text-body tabular-nums active:bg-accent"
                      aria-label={t("allFor", { count: line.open, name })}
                      disabled={session.submitting}
                      onClick={() => session.setLineCount(line.id, line.open)}
                    >
                      {t("lineCounted", { counted: lineCount, open: line.open })}
                    </button>
                    <button
                      type="button"
                      className={ROW_BUTTON}
                      disabled={lineCount >= line.open || session.submitting}
                      aria-label={t("oneMore", { name })}
                      onClick={() => session.setLineCount(line.id, lineCount + 1)}
                    >
                      <Plus className="size-4" />
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {receiving.doneLines > 0 ? (
          <p className="px-4 py-3 text-body text-muted-foreground">{t("linesDone", { count: receiving.doneLines })}</p>
        ) : null}
      </div>

      <div className="shrink-0 space-y-2 border-t bg-card px-3 py-3">
        {session.problem ? (
          <div role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-body text-destructive">{session.problem}</div>
        ) : null}
        {receiving.kind === "purchaseOrder" ? (
          <div className="flex items-center justify-between gap-3 rounded-lg bg-muted px-4 py-2">
            <div className="min-w-0">
              <Label htmlFor="scanner-update-cost">{t("updateCost")}</Label>
              <p className="text-body text-muted-foreground">{t("updateCostHelp")}</p>
            </div>
            <Switch
              id="scanner-update-cost"
              checked={session.updateCost}
              disabled={session.submitting}
              onCheckedChange={session.setUpdateCost}
            />
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => void session.submit()}
          disabled={counted === 0 || session.submitting}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-lg bg-primary text-body font-semibold text-primary-foreground active:opacity-80 disabled:opacity-40"
        >
          {session.submitting ? (
            <>
              <span className="size-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
              {t("saving")}
            </>
          ) : counted === 0 ? t("countToReceive") : counted === 1 ? t("receiveUnitsOne") : t("receiveUnits", { count: counted })}
        </button>
      </div>
    </>
  );
}

function ChoiceList({ session, showDestination }: { session: ReceiveSession; showDestination: boolean }) {
  const t = useMessages(scannerMessages);
  const { choices } = session;
  const sections: ReadonlyArray<readonly ["purchaseOrders" | "transfers", ReceiveChoice[]]> = choices.status === "ready"
    ? [["purchaseOrders", choices.purchaseOrders], ["transfers", choices.transfers]]
    : [];
  const empty = choices.status === "ready" && choices.purchaseOrders.length + choices.transfers.length === 0;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="space-y-1 px-4 py-3">
        <h2 className="text-heading-md font-semibold">{t("receiveChoose")}</h2>
        <p className="text-body text-muted-foreground">{t(showDestination ? "receiveChooseHintAll" : "receiveChooseHint")}</p>
      </div>
      {session.notice ? (
        <p role="status" className="mx-4 mb-2 rounded-lg bg-primary/15 px-3 py-2 text-body">{session.notice}</p>
      ) : null}
      {session.openFailed ? (
        <div role="alert" className="mx-4 mb-2 rounded-lg bg-destructive/10 px-3 py-2 text-body text-destructive">{t("documentFailed")}</div>
      ) : null}

      {choices.status === "loading" ? (
        <div className="flex justify-center py-10">
          <div className="size-8 animate-spin rounded-full border-2 border-muted border-t-foreground" />
        </div>
      ) : choices.status === "failed" ? (
        <div role="alert" className="mx-4 flex items-center justify-between gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-body text-destructive">
          <span>{t("documentsFailed")}</span>
          <button type="button" onClick={() => void session.loadChoices()} className="flex h-11 shrink-0 items-center gap-2 rounded-lg px-3 font-medium active:bg-accent">
            <RefreshCw className="size-4" />
            {t("retry")}
          </button>
        </div>
      ) : empty ? (
        <div className="px-4 py-10 text-center">
          <p className="text-body font-medium">{t("nothingToReceive")}</p>
          <p className="mt-1 text-body text-muted-foreground">{t("nothingToReceiveHint")}</p>
        </div>
      ) : (
        sections.map(([key, rows]) => (rows.length === 0 ? null : (
          <section key={key} aria-label={t(key)} className="pb-2">
            <h3 className="px-4 pb-1 pt-3 text-body font-medium text-muted-foreground">{t(key)}</h3>
            <ul className="divide-y border-y bg-card">
              {rows.map((choice) => (
                <li key={choice.id}>
                  <button
                    type="button"
                    disabled={session.opening !== null && !session.openFailed}
                    onClick={() => void session.open(choice)}
                    className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-start active:bg-accent disabled:opacity-60"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-body font-semibold">{choice.number}</p>
                      <p className="truncate text-body text-muted-foreground">
                        {[choice.title ?? t("noSupplier"), showDestination && choice.kind === "purchaseOrder" ? t("toLocation", { location: choice.destination }) : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                    <span className="shrink-0 text-body tabular-nums">
                      {session.opening?.id === choice.id && !session.openFailed ? (
                        <span className="inline-block size-4 animate-spin rounded-full border-2 border-muted border-t-foreground" />
                      ) : t("toReceive", { count: choice.open })}
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )))
      )}
    </div>
  );
}
