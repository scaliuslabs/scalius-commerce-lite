import { useRef, useState, type KeyboardEvent } from "react";
import { ScanBarcode } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Field } from "~/components/ui/field";
import { NumberInput } from "~/components/ui/number-input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { useIsMobile } from "~/hooks/use-mobile";
import { formatNumber, useMessages } from "~/i18n";
import { purchasingMessages } from "~/i18n/purchasing";
import { cn } from "@scalius/shared/utils";
import { lineName } from "./purchasing-format";
import { LineProduct } from "./purchasing-ui";
import { applyScan, type ScanOutcome } from "./scan";

/** A line that can take units now: a purchase order's open quantity, a transfer's in transit. */
export interface ReceivableLine {
  id: string;
  productId: string;
  productName: string | null;
  optionLabel: string | null;
  sku: string;
  barcode: string | null;
  /** The most this receipt can take for the line. */
  open: number;
  received: number;
  total: number;
  /** The SKU was removed from its product: it can't be received until restored. */
  retired: boolean;
}

export type ReceiveQuantities = Record<string, number | null>;

/**
 * The receipt the quantities describe: the lines with units, and the lines
 * whose number can't be sent (not whole, below 0, more than still to come,
 * or a removed SKU).
 */
export function readReceipt(lines: readonly ReceivableLine[], quantities: ReceiveQuantities) {
  const invalid = new Set<string>();
  const receipt: Array<{ lineId: string; quantity: number }> = [];
  for (const line of lines) {
    const quantity = quantities[line.id] ?? 0;
    if (quantity === null || quantity === 0) continue;
    const max = line.retired ? 0 : line.open;
    if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > max) {
      invalid.add(line.id);
      continue;
    }
    receipt.push({ lineId: line.id, quantity });
  }
  return { lines: receipt, invalid, units: receipt.reduce((sum, line) => sum + line.quantity, 0) };
}

/** Every receivable line at its open quantity. */
export function receiveEverything(lines: readonly ReceivableLine[]): ReceiveQuantities {
  return Object.fromEntries(lines.map((line) => [line.id, line.retired ? 0 : line.open]));
}

/**
 * The lines of a receipt: a scan field for keyboard-wedge barcode scanners
 * (the code, then Enter: one unit per scan), and per line how many arrived,
 * with an All shortcut. Quantities belong to the page, which sends them.
 */
export function ReceiveLines({
  lines,
  quantities,
  onChange,
  notOnDocument,
  disabled = false,
}: {
  lines: readonly ReceivableLine[];
  quantities: ReceiveQuantities;
  onChange: (next: ReceiveQuantities) => void;
  /** "Not on this purchase order: {code}". */
  notOnDocument: (code: string) => string;
  disabled?: boolean;
}) {
  const t = useMessages(purchasingMessages);
  const isMobile = useIsMobile();
  const [code, setCode] = useState("");
  const [outcome, setOutcome] = useState<ScanOutcome | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const { invalid } = readReceipt(lines, quantities);
  const receivable = lines.filter((line) => !line.retired && line.open > 0);
  const byId = new Map(lines.map((line) => [line.id, line]));

  const scan = () => {
    if (!code.trim()) return;
    const result = applyScan(
      receivable.map((line) => ({ id: line.id, sku: line.sku, barcode: line.barcode, max: line.open })),
      quantities,
      code,
    );
    setOutcome(result.outcome);
    if (result.outcome.kind === "counted") onChange(result.quantities);
    setCode("");
  };

  const onScanKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    scan();
  };

  const outcomeText = (() => {
    if (!outcome) return null;
    if (outcome.kind === "unknown") return { tone: "critical", text: notOnDocument(outcome.code) } as const;
    const line = byId.get(outcome.lineId);
    const name = line ? lineName(line, t("unknownProduct")) : "";
    return outcome.kind === "counted"
      ? { tone: "muted", text: t("scanCounted", { name, count: outcome.quantity }) } as const
      : { tone: "warning", text: t("scanFull", { name }) } as const;
  })();

  const setQuantity = (id: string, value: number | null) => onChange({ ...quantities, [id]: value });

  const quantityField = (line: ReceivableLine) => {
    const name = lineName(line, t("unknownProduct"));
    const lineInvalid = invalid.has(line.id);
    const closed = line.retired || line.open === 0;
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-end gap-2">
          <NumberInput
            integer
            className="w-24"
            value={quantities[line.id] ?? null}
            placeholder="0"
            disabled={disabled || closed}
            aria-label={t("receivingFor", { name })}
            aria-invalid={lineInvalid ? true : undefined}
            aria-describedby={lineInvalid ? `receive-${line.id}-error` : undefined}
            onValueChange={(value) => setQuantity(line.id, value)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || closed}
            aria-label={t("allFor", { name })}
            onClick={() => setQuantity(line.id, line.open)}
          >
            {t("all")}
          </Button>
        </div>
        {lineInvalid ? (
          <p id={`receive-${line.id}-error`} className="text-end text-body text-destructive">
            {line.retired ? t("retiredLine") : t("receiveInvalid", { max: line.open })}
          </p>
        ) : line.retired ? (
          <p className="text-end text-body text-muted-foreground">{t("retiredLine")}</p>
        ) : null}
      </div>
    );
  };

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>{t("products")}</CardTitle>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange({})}>
            {t("clearCounts")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || receivable.length === 0}
            onClick={() => onChange(receiveEverything(lines))}
          >
            {t("receiveAll")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-1">
        <Field id="receive-scan" label={t("scanLabel")} help={t("scanHelp")}>
          <Input
            ref={scanRef}
            prefix={<ScanBarcode aria-hidden className="size-4" />}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="enter"
            placeholder={t("scanPlaceholder")}
            disabled={disabled || receivable.length === 0}
            value={code}
            aria-describedby="receive-scan-help receive-scan-status"
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={onScanKey}
          />
        </Field>
        <p
          id="receive-scan-status"
          role="status"
          aria-live="polite"
          className={cn(
            "min-h-lh text-body",
            outcomeText?.tone === "critical" && "text-destructive",
            outcomeText?.tone === "warning" && "text-warning",
            outcomeText?.tone === "muted" && "text-muted-foreground",
          )}
        >
          {outcomeText?.text ?? ""}
        </p>
      </CardContent>
      {isMobile ? (
        <ul className="divide-y border-t">
          {lines.map((line) => (
            <li key={line.id} className="space-y-2 px-4 py-3">
              <LineProduct line={line} retired={line.retired} />
              <p className="text-body text-muted-foreground tabular-nums">
                {t("receivedOf", { received: line.received, total: line.total })}
                {" · "}
                {t("colStillToCome")}: {formatNumber(line.open)}
              </p>
              {quantityField(line)}
            </li>
          ))}
        </ul>
      ) : (
        <div className="border-t">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colProduct")}</TableHead>
                <TableHead data-numeric="">{t("colReceived")}</TableHead>
                <TableHead data-numeric="">{t("colStillToCome")}</TableHead>
                <TableHead data-numeric="">{t("colReceiving")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell className="py-2">
                    <LineProduct line={line} retired={line.retired} />
                  </TableCell>
                  <TableCell data-numeric="">{t("receivedOf", { received: line.received, total: line.total })}</TableCell>
                  <TableCell data-numeric="">{formatNumber(line.open)}</TableCell>
                  <TableCell className="py-2">{quantityField(line)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  );
}
