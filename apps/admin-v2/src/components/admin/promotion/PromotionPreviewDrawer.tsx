import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Plus,
  ReceiptText,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import { majorToMinor, minorToMajor } from "./promotion-editor-model";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import { usePreviewPromotion } from "~/lib/api-mutations/promotions";

interface PreviewLine {
  key: number;
  price: string;
  quantity: string;
}

interface PreviewAllocation {
  target: string;
  lineId: string | null;
  baseAmountMinor: number;
  discountAmountMinor: number;
}

interface PreviewOutcome {
  assumedActive: boolean;
  applied: null | {
    totalDiscountMinor: number;
    allocations: PreviewAllocation[];
  };
  rejected: Array<{ reason: string }>;
  unmatchedCodes: string[];
}

const REJECTION_LABELS: Record<string, string> = {
  inactive: "Promotion is not active",
  not_started: "Scheduled start has not arrived",
  expired: "Schedule has ended",
  code_not_submitted: "Selected code did not match",
  redemption_limit_reached: "Total-use budget is exhausted",
  customer_redemption_limit_reached: "Customer-use budget is exhausted",
  discount_budget_exhausted: "Discount spend budget is exhausted",
  discount_budget_insufficient: "Remaining spend budget cannot fund this cart",
  minimum_subtotal_not_met: "Minimum subtotal is not met",
  minimum_quantity_not_met: "Minimum item quantity is not met",
  condition_currency_mismatch: "Cart and minimum use different currencies",
  effect_currency_mismatch: "Cart and discount use different currencies",
  no_savings: "The configured outcome creates no savings",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function readPreviewOutcome(value: unknown): PreviewOutcome | null {
  const candidate = isRecord(value) && isRecord(value.data) ? value.data : value;
  if (!isRecord(candidate)) return null;
  const rawApplied = candidate.applied;
  const applied = rawApplied === null || rawApplied === undefined
    ? null
    : isRecord(rawApplied)
      && typeof rawApplied.totalDiscountMinor === "number"
      && Array.isArray(rawApplied.allocations)
      ? {
        totalDiscountMinor: rawApplied.totalDiscountMinor,
        allocations: rawApplied.allocations.filter(isRecord).map((allocation) => ({
          target: typeof allocation.target === "string" ? allocation.target : "order",
          lineId: typeof allocation.lineId === "string" ? allocation.lineId : null,
          baseAmountMinor: typeof allocation.baseAmountMinor === "number" ? allocation.baseAmountMinor : 0,
          discountAmountMinor: typeof allocation.discountAmountMinor === "number" ? allocation.discountAmountMinor : 0,
        })),
      }
      : null;
  const rejected = Array.isArray(candidate.rejected)
    ? candidate.rejected.filter(isRecord).map((item) => ({
      reason: typeof item.reason === "string" ? item.reason : "invalid_configuration",
    }))
    : [];
  return {
    assumedActive: candidate.assumedActive === true,
    applied,
    rejected,
    unmatchedCodes: Array.isArray(candidate.unmatchedCodes)
      ? candidate.unmatchedCodes.filter((code): code is string => typeof code === "string")
      : [],
  };
}

function mutationError(error: unknown): string {
  return error instanceof Error ? error.message : "The saved promotion could not be evaluated.";
}

function previewAmountMinor(value: string, currencyCode: string): number | null {
  return /^0+(?:\.0+)?$/u.test(value.trim())
    ? 0
    : majorToMinor(value, currencyCode);
}

export function PromotionPreviewDrawer({
  open,
  onOpenChange,
  promotionId,
  revision,
  codes,
  currencyCode,
  currencySymbol,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  promotionId: string;
  revision: number;
  codes: Array<{ code: string; isActive: boolean }>;
  currencyCode: string;
  currencySymbol: string;
}) {
  const [lines, setLines] = useState<PreviewLine[]>([
    { key: 1, price: "1000", quantity: "1" },
  ]);
  const [nextLineKey, setNextLineKey] = useState(2);
  const [shipping, setShipping] = useState("100");
  const [customerId, setCustomerId] = useState("");
  const usableCodes = codes.filter(({ isActive }) => isActive);
  const [selectedCode, setSelectedCode] = useState(
    usableCodes[0]?.code ?? codes[0]?.code ?? "",
  );
  const previewMutation = usePreviewPromotion();
  const result = readPreviewOutcome(previewMutation.data);

  const cartIssue = useMemo(() => {
    if (lines.length === 0) return "Add at least one cart line.";
    for (const line of lines) {
      if (majorToMinor(line.price, currencyCode) === null) return "Every line needs a positive valid price.";
      if (!/^\d+$/u.test(line.quantity) || Number(line.quantity) < 1) return "Every quantity must be a positive whole number.";
    }
    if (shipping && previewAmountMinor(shipping, currencyCode) === null) return "Delivery must be zero or a positive valid amount.";
    return null;
  }, [currencyCode, lines, shipping]);

  function evaluate() {
    if (cartIssue || !selectedCode) return;
    previewMutation.mutate({
      id: promotionId,
      expectedRevision: revision,
      customerId: customerId.trim() || null,
      cart: {
        currencyCode,
        lines: lines.map((line) => ({
          id: `preview_line_${line.key}`,
          productId: `preview_product_${line.key}`,
          variantId: `preview_variant_${line.key}`,
          unitPriceMinor: majorToMinor(line.price, currencyCode)!,
          quantity: Number(line.quantity),
        })),
        shippingAmountMinor: shipping ? previewAmountMinor(shipping, currencyCode)! : 0,
        submittedCodes: [selectedCode],
        evaluatedAtEpochSeconds: Math.floor(Date.now() / 1_000),
      },
    });
  }

  const subtotalMinor = lines.reduce(
    (total, line) => total + (majorToMinor(line.price, currencyCode) ?? 0) * (Number(line.quantity) || 0),
    0,
  );

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) previewMutation.reset();
      }}
    >
      <SheetContent className="flex w-full flex-col p-0 sm:max-w-xl">
        <SheetHeader className="relative border-b px-5 py-4 pr-14 text-left">
          <SheetTitle>Test saved promotion</SheetTitle>
          <SheetDescription>
            Run the production evaluator against a sample cart. Nothing is ordered or redeemed.
          </SheetDescription>
          <SheetClose asChild>
            <Button type="button" variant="ghost" size="icon" className="absolute right-4 top-4 size-8" aria-label="Close preview">
              <X className="size-4" />
            </Button>
          </SheetClose>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-5 p-5">
            <section className="space-y-3" aria-labelledby="preview-cart-title">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 id="preview-cart-title" className="text-sm font-semibold">Sample cart</h3>
                  <p className="text-xs text-muted-foreground">Only price and quantity affect current item rules.</p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8"
                  onClick={() => {
                    setLines((current) => [...current, { key: nextLineKey, price: "500", quantity: "1" }]);
                    setNextLineKey((current) => current + 1);
                  }}
                  disabled={lines.length >= 20}
                >
                  <Plus className="mr-1.5 size-3.5" />Line
                </Button>
              </div>
              <div className="overflow-hidden rounded-lg border">
                {lines.map((line, index) => (
                  <div key={line.key} className={`grid grid-cols-[1fr_5.5rem_2rem] gap-2 p-2.5 ${index > 0 ? "border-t" : ""}`}>
                    <label className="relative">
                      <span className="sr-only">Line {index + 1} unit price</span>
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{currencySymbol}</span>
                      <Input
                        value={line.price}
                        inputMode="decimal"
                        onChange={(event) => setLines((current) => current.map((item) => (
                          item.key === line.key ? { ...item, price: event.target.value } : item
                        )))}
                        className="h-9 pl-8"
                      />
                    </label>
                    <label>
                      <span className="sr-only">Line {index + 1} quantity</span>
                      <Input
                        value={line.quantity}
                        inputMode="numeric"
                        onChange={(event) => setLines((current) => current.map((item) => (
                          item.key === line.key ? { ...item, quantity: event.target.value } : item
                        )))}
                        className="h-9"
                        aria-label={`Line ${index + 1} quantity`}
                      />
                    </label>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-9 text-muted-foreground hover:text-destructive"
                      onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))}
                      aria-label={`Remove line ${index + 1}`}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5">
                  <Label>Delivery charge</Label>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{currencySymbol}</span>
                    <Input value={shipping} onChange={(event) => setShipping(event.target.value)} inputMode="decimal" className="h-9 pl-8" />
                  </div>
                </label>
                <label className="space-y-1.5">
                  <Label>Checkout code</Label>
                  <Select value={selectedCode} onValueChange={setSelectedCode}>
                    <SelectTrigger className="h-9 font-mono"><SelectValue placeholder="Select code" /></SelectTrigger>
                    <SelectContent>
                      {(usableCodes.length > 0 ? usableCodes : codes).map(({ code }) => (
                        <SelectItem key={code} value={code}>{code}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              </div>
              <label className="block space-y-1.5">
                <Label>Customer ID <span className="font-normal text-muted-foreground">(optional)</span></Label>
                <Input value={customerId} onChange={(event) => setCustomerId(event.target.value)} className="h-9" placeholder="Test a per-customer limit" />
              </label>
              {cartIssue ? <p className="text-xs text-destructive">{cartIssue}</p> : null}
              <div className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Cart before discount</span>
                <span className="font-semibold tabular-nums">
                  {currencySymbol}{minorToMajor(subtotalMinor + (shipping ? previewAmountMinor(shipping, currencyCode) ?? 0 : 0), currencyCode)}
                </span>
              </div>
              <Button type="button" className="w-full" onClick={evaluate} disabled={Boolean(cartIssue || !selectedCode || previewMutation.isPending)}>
                {previewMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ReceiptText className="mr-2 size-4" />}
                Evaluate cart
              </Button>
            </section>

            {previewMutation.isError ? (
              <Alert variant="destructive">
                <AlertCircle className="size-4" />
                <AlertTitle>Preview could not run</AlertTitle>
                <AlertDescription>{mutationError(previewMutation.error)}</AlertDescription>
              </Alert>
            ) : null}

            {result ? (
              <section className="space-y-3 border-t pt-5" aria-live="polite">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold">Evaluator result</h3>
                  {result.assumedActive ? <Badge variant="outline">Draft assumed active</Badge> : null}
                </div>
                {result.applied ? (
                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                        <CheckCircle2 className="size-4" />Applied
                      </div>
                      <span className="text-lg font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
                        −{currencySymbol}{minorToMajor(result.applied.totalDiscountMinor, currencyCode)}
                      </span>
                    </div>
                    <div className="mt-3 divide-y rounded-lg border bg-background/80">
                      {result.applied.allocations.map((allocation, index) => (
                        <div key={`${allocation.target}:${allocation.lineId ?? "cart"}:${index}`} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                          <span className="capitalize text-muted-foreground">
                            {allocation.target === "line" ? `Item line ${allocation.lineId?.replace("preview_line_", "") ?? ""}` : allocation.target}
                          </span>
                          <span className="font-medium tabular-nums">−{currencySymbol}{minorToMajor(allocation.discountAmountMinor, currencyCode)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
                    <div className="flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-300">
                      <AlertCircle className="size-4" />Not applied
                    </div>
                    <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                      {result.rejected.map(({ reason }, index) => (
                        <li key={`${reason}:${index}`}>• {REJECTION_LABELS[reason] ?? reason.replaceAll("_", " ")}</li>
                      ))}
                      {result.unmatchedCodes.map((code) => <li key={code}>• Code {code} is not owned by this promotion</li>)}
                    </ul>
                  </div>
                )}
              </section>
            ) : null}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
