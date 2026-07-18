import JsBarcode from "jsbarcode";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  Minus,
  Plus,
  Printer,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useCurrency } from "@/hooks/use-currency";
import { useDebounce } from "@/hooks/use-debounce";
import {
  getInventory,
  getInventoryLabelPreview,
} from "@/lib/api-functions/inventory";
import { cn } from "@scalius/shared/utils";
import {
  buildLabelCopies,
  DEFAULT_LABEL_CONTENT,
  formatLabelCount,
  formatPageCount,
  findCompatibleLabelPreset,
  getBarcodeFitIssue,
  getLabelDimensions,
  getLabelInventorySummary,
  getLabelPreset,
  getLabelPresetIssue,
  getLabelShortcutQuantity,
  LABEL_PRESETS,
  MAX_LABEL_COPIES,
  MAX_LABEL_SKUS,
  paginateLabelCopies,
  resolveBarcodeSymbol,
  type BarcodeSymbol,
  type LabelContentOptions,
  type LabelCopy,
  type LabelPageCell,
  type LabelPreset,
  type LabelPresetId,
  type LabelQuantityShortcut,
} from "./barcode-label-model";

const LABEL_PREFERENCE_KEY = "scalius:barcode-label-preferences:v1";

type BarcodeLabelWorkspaceProps = {
  selectedVariantIds: string[];
  onSelectedVariantIdsChange: (ids: string[]) => void;
};

type PrintMode = "job" | "test";

const DEFAULT_CUSTOM_PRESET: LabelPreset = { ...getLabelPreset("custom") };

function MillimetreInput({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px] font-normal text-muted-foreground">{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => {
            const next = event.target.valueAsNumber;
            if (Number.isFinite(next)) onChange(Math.max(min, Math.min(max, next)));
          }}
          className="h-8 pr-8 text-sm tabular-nums"
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">mm</span>
      </div>
    </div>
  );
}

function BarcodeGraphic({
  symbol,
  compact = false,
}: {
  symbol: BarcodeSymbol;
  compact?: boolean;
}) {
  const ref = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (!ref.current || !symbol.format || symbol.error) return;
    try {
      JsBarcode(ref.current, symbol.value, {
        format: symbol.format,
        displayValue: false,
        margin: 0,
        width: 2,
        height: compact ? 32 : 54,
        background: "#ffffff",
        lineColor: "#09090b",
      });
      ref.current.setAttribute("preserveAspectRatio", "xMidYMid meet");
      ref.current.removeAttribute("width");
      ref.current.removeAttribute("height");
    } catch {
      ref.current.replaceChildren();
    }
  }, [compact, symbol]);

  if (!symbol.format || symbol.error) {
    return (
      <div className="grid h-10 place-items-center rounded border border-dashed border-amber-400 bg-amber-50 px-2 text-center text-[9px] font-medium text-amber-800">
        Barcode unavailable
      </div>
    );
  }

  return <svg ref={ref} aria-label={`Barcode ${symbol.displayValue}`} className="block h-auto max-h-full w-full" />;
}

function LabelArtwork({
  copy,
  content,
  price,
  compact,
}: {
  copy: LabelCopy;
  content: LabelContentOptions;
  price: string;
  compact: boolean;
}) {
  const { variant, symbol } = copy;
  return (
    <div className="flex h-full min-h-0 flex-col justify-center overflow-hidden bg-white px-[1.5mm] py-[1mm] text-[#09090b]">
      <div className="min-h-0 flex-1">
        <BarcodeGraphic symbol={symbol} compact={compact} />
      </div>
      <div className="mt-[0.4mm] truncate text-center font-mono text-[7pt] leading-none tracking-tight">
        {symbol.displayValue}
      </div>
      <div className="mt-[0.6mm] min-w-0 text-center leading-tight">
        {content.showProduct ? (
          <div className={cn("truncate font-semibold", compact ? "text-[6.5pt]" : "text-[7.5pt]")}>{variant.productName}</div>
        ) : null}
        {content.showVariant && variant.optionLabel ? (
          <div className={cn("truncate text-zinc-600", compact ? "text-[5.5pt]" : "text-[6.5pt]")}>{variant.optionLabel}</div>
        ) : null}
        <div className={cn("flex min-w-0 items-center justify-center gap-[1.5mm] text-zinc-700", compact ? "text-[5.5pt]" : "text-[6.5pt]") }>
          {content.showSku ? <span className="truncate font-mono">{variant.sku}</span> : null}
          {content.showPrice ? <span className="shrink-0 font-semibold">{price}</span> : null}
        </div>
      </div>
    </div>
  );
}

function QuantityControl({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
}) {
  return (
    <div className="flex h-8 items-center overflow-hidden rounded-md border bg-background">
      <button
        type="button"
        onClick={() => onChange(Math.max(0, value - 1))}
        className="grid h-full w-8 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-label={`Decrease labels for ${label}`}
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <Input
        type="number"
        min={0}
        max={MAX_LABEL_COPIES}
        value={value}
        onChange={(event) => onChange(Math.max(0, Math.min(MAX_LABEL_COPIES, Math.trunc(event.target.valueAsNumber || 0))))}
        aria-label={`Label quantity for ${label}`}
        className="h-full w-14 rounded-none border-x border-y-0 px-1 text-center text-sm tabular-nums shadow-none focus-visible:ring-0"
      />
      <button
        type="button"
        onClick={() => onChange(Math.min(MAX_LABEL_COPIES, value + 1))}
        className="grid h-full w-8 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-label={`Increase labels for ${label}`}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function PrintPages({
  pages,
  preset,
  content,
  formatPrice,
  test,
}: {
  pages: LabelPageCell[][];
  preset: LabelPreset;
  content: LabelContentOptions;
  formatPrice: (price: number | string) => string;
  test: boolean;
}) {
  const capacity = preset.columns * preset.rows;
  const firstCopy = pages.flat().find((copy): copy is LabelCopy => copy !== null);
  const firstOccupiedIndex = Math.max(0, pages[0]?.findIndex((copy) => copy !== null) ?? 0);
  const printPages = test
    ? [Array.from({ length: capacity }, (_, index) => index === firstOccupiedIndex ? firstCopy ?? null : null)]
    : pages.map((page) => Array.from({ length: capacity }, (_, index) => page[index] ?? null));
  const dimensions = getLabelDimensions(preset);

  return (
    <div id="barcode-print-root" data-print-mode={test ? "test" : "job"}>
      {printPages.map((page, pageIndex) => (
        <div
          // Page order is stable and the key must not depend on copy count.
          key={`page-${pageIndex}`}
          className="barcode-print-page"
          style={{
            width: `${preset.pageWidthMm}mm`,
            height: `${preset.pageHeightMm}mm`,
            padding: `${preset.marginYmm}mm ${preset.marginXmm}mm`,
            gridTemplateColumns: `repeat(${preset.columns}, ${dimensions.widthMm}mm)`,
            gridTemplateRows: `repeat(${preset.rows}, ${dimensions.heightMm}mm)`,
            columnGap: `${preset.gapXmm}mm`,
            rowGap: `${preset.gapYmm}mm`,
          }}
        >
          {page.map((copy, labelIndex) => (
            <div
              key={copy?.key ?? `empty-${labelIndex}`}
              className={cn(
                "barcode-print-label",
                (preset.cropMarks || test) && "barcode-cut-guide",
              )}
            >
              {copy ? (
                <LabelArtwork
                  copy={copy}
                  content={content}
                  price={formatPrice(copy.variant.effectivePrice)}
                  compact={dimensions.heightMm < 30 || dimensions.widthMm < 50}
                />
              ) : test ? (
                <div className="grid h-full place-items-center text-[6pt] text-zinc-400">{labelIndex + 1}</div>
              ) : null}
            </div>
          ))}
          {test ? (
            <div className="barcode-test-note">
              Test at Actual size / 100% · disable browser headers and footers · scan the first label before printing the batch
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function PaperPreview({
  page,
  preset,
  content,
  formatPrice,
  startOffset,
  onStartOffsetChange,
}: {
  page: LabelPageCell[];
  preset: LabelPreset;
  content: LabelContentOptions;
  formatPrice: (price: number | string) => string;
  startOffset: number;
  onStartOffsetChange: (value: number) => void;
}) {
  const capacity = preset.columns * preset.rows;
  const cells = Array.from({ length: capacity }, (_, index) => page[index] ?? null);
  return (
    <div className="mx-auto w-full max-w-[310px]">
      <div
        className="grid overflow-hidden border border-zinc-300 bg-white shadow-[0_10px_30px_rgba(0,0,0,0.12)]"
        style={{
          aspectRatio: `${preset.pageWidthMm}/${preset.pageHeightMm}`,
          gridTemplateColumns: `repeat(${preset.columns}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${preset.rows}, minmax(0, 1fr))`,
          gap: preset.thermal ? 0 : "2px",
          padding: preset.thermal ? "5px" : "10px",
        }}
        aria-label={`Preview of ${preset.name}`}
      >
        {cells.map((copy, index) => (
          <button
            type="button"
            key={copy?.key ?? `preview-empty-${index}`}
            className={cn(
              "group relative min-h-0 overflow-hidden bg-white text-left focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500",
              preset.cropMarks && "border border-dashed border-zinc-300",
              index === startOffset && capacity > 1 && "ring-2 ring-inset ring-emerald-500",
            )}
            aria-label={`Start printing at cell ${index + 1}`}
            aria-pressed={index === startOffset}
            disabled={capacity <= 1}
            onClick={() => onStartOffsetChange(index)}
          >
            {copy ? (
              <LabelArtwork copy={copy} content={content} price={formatPrice(copy.variant.effectivePrice)} compact />
            ) : capacity > 1 ? (
              <span className="grid h-full place-items-center text-[8px] text-zinc-400 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">{index + 1}</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

export function BarcodeLabelWorkspace({
  selectedVariantIds,
  onSelectedVariantIdsChange,
}: BarcodeLabelWorkspaceProps) {
  const { formatPrice } = useCurrency();
  const [searchInput, setSearchInput] = useState("");
  const [searchPage, setSearchPage] = useState(1);
  const search = useDebounce(searchInput, 250);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [presetId, setPresetId] = useState<LabelPresetId>("a4-cut-3x8");
  const [customPreset, setCustomPreset] = useState<LabelPreset>(DEFAULT_CUSTOM_PRESET);
  const [startOffset, setStartOffset] = useState(0);
  const [content, setContent] = useState<LabelContentOptions>(DEFAULT_LABEL_CONTENT);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [printMode, setPrintMode] = useState<PrintMode | null>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(LABEL_PREFERENCE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as {
          presetId?: LabelPresetId;
          content?: Partial<LabelContentOptions>;
          customPreset?: Partial<LabelPreset>;
        };
        if (LABEL_PRESETS.some((preset) => preset.id === parsed.presetId)) setPresetId(parsed.presetId!);
        if (parsed.content) setContent((current) => ({ ...current, ...parsed.content }));
        if (parsed.customPreset) {
          setCustomPreset((current) => ({ ...current, ...parsed.customPreset, id: "custom", name: current.name, detail: current.detail }));
        }
      }
    } catch {
      // Device-local preferences are optional; printing remains available.
    } finally {
      setPreferencesLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!preferencesLoaded) return;
    try {
      window.localStorage.setItem(LABEL_PREFERENCE_KEY, JSON.stringify({ presetId, content, customPreset }));
    } catch {
      // Ignore blocked or exhausted local storage.
    }
  }, [content, customPreset, preferencesLoaded, presetId]);

  const previewQuery = useQuery({
    queryKey: ["inventory", "label-preview", selectedVariantIds],
    queryFn: () => getInventoryLabelPreview({ data: { variantIds: selectedVariantIds } }),
    enabled: selectedVariantIds.length > 0,
    staleTime: 30_000,
  });

  const pickerQuery = useQuery({
    queryKey: ["inventory", "label-picker", search, searchPage],
    queryFn: () => getInventory({ data: {
      section: "variants",
      search: search || undefined,
      page: searchPage,
      limit: 20,
      sort: "productName",
      order: "asc",
    } }),
    staleTime: 30_000,
  });

  const selectedVariants = useMemo(
    () => previewQuery.data?.variants ?? [],
    [previewQuery.data],
  );
  useEffect(() => {
    if (selectedVariants.length === 0) return;
    setQuantities((current) => {
      const next = { ...current };
      for (const variant of selectedVariants) {
        if (next[variant.id] === undefined) next[variant.id] = 1;
      }
      return next;
    });
  }, [selectedVariants]);

  const preset = presetId === "custom" ? customPreset : getLabelPreset(presetId);
  const capacity = preset.columns * preset.rows;
  const presetIssue = getLabelPresetIssue(preset);
  useEffect(() => {
    setStartOffset((current) => Math.min(current, Math.max(0, capacity - 1)));
  }, [capacity]);
  const copies = useMemo(() => buildLabelCopies(selectedVariants, quantities), [quantities, selectedVariants]);
  const pages = useMemo(
    () => paginateLabelCopies(copies.slice(0, MAX_LABEL_COPIES), preset, startOffset),
    [copies, preset, startOffset],
  );
  const activeFitIssues = useMemo(() => selectedVariants.flatMap((variant) => {
    if (presetIssue) return [];
    if ((quantities[variant.id] ?? 0) <= 0) return [];
    const symbol = resolveBarcodeSymbol(variant.barcode, variant.barcodeType);
    const issue = getBarcodeFitIssue(symbol, preset);
    return issue ? [{ variant, issue }] : [];
  }), [preset, presetIssue, quantities, selectedVariants]);
  const activeSymbols = useMemo(() => selectedVariants
    .filter((variant) => (quantities[variant.id] ?? 0) > 0)
    .map((variant) => resolveBarcodeSymbol(variant.barcode, variant.barcodeType)), [quantities, selectedVariants]);
  const compatiblePreset = useMemo(() => activeFitIssues.length > 0
    ? findCompatibleLabelPreset(activeSymbols, preset)
    : null, [activeFitIssues.length, activeSymbols, preset]);
  const tooManyCopies = copies.length > MAX_LABEL_COPIES;
  const canPrint = copies.length > 0 && !tooManyCopies && !presetIssue && activeFitIssues.length === 0;
  const pickerVariants = pickerQuery.data?.variants ?? [];
  const pickerPagination = pickerQuery.data?.pagination;

  const updateSelected = (id: string, selected: boolean) => {
    if (selected) {
      if (selectedVariantIds.length >= MAX_LABEL_SKUS || selectedVariantIds.includes(id)) return;
      onSelectedVariantIdsChange([...selectedVariantIds, id]);
      return;
    }
    onSelectedVariantIdsChange(selectedVariantIds.filter((candidate) => candidate !== id));
  };

  const setAllQuantities = (mode: LabelQuantityShortcut) => {
    setQuantities((current) => Object.fromEntries(selectedVariants.map((variant) => [
      variant.id,
      getLabelShortcutQuantity(variant, current[variant.id] ?? 1, mode),
    ]).concat(Object.entries(current).filter(([id]) => !selectedVariants.some((variant) => variant.id === id)))));
  };

  const startPrint = (mode: PrintMode) => {
    if (!canPrint) return;
    setPrintMode(mode);
  };

  useEffect(() => {
    if (!printMode) return;
    const frame = window.requestAnimationFrame(() => {
      window.print();
      setPrintMode(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [printMode]);

  useEffect(() => {
    const reset = () => setPrintMode(null);
    window.addEventListener("afterprint", reset);
    return () => window.removeEventListener("afterprint", reset);
  }, []);

  return (
    <>
      <style>{`
        @media screen { #barcode-print-root { display: none; } }
        @media print {
          @page { size: ${preset.pageWidthMm}mm ${preset.pageHeightMm}mm; margin: 0; }
          html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
          body * { visibility: hidden !important; }
          #barcode-print-root, #barcode-print-root * { visibility: visible !important; }
          #barcode-print-root { display: block !important; position: absolute !important; inset: 0 auto auto 0 !important; margin: 0 !important; padding: 0 !important; background: #fff !important; color: #09090b !important; }
          .barcode-print-page { position: relative; display: grid; box-sizing: border-box; overflow: hidden; break-after: page; page-break-after: always; background: #fff; }
          .barcode-print-page:last-child { break-after: auto; page-break-after: auto; }
          .barcode-print-label { box-sizing: border-box; min-width: 0; min-height: 0; overflow: hidden; background: #fff; }
          .barcode-cut-guide { outline: 0.15mm dashed #a1a1aa; outline-offset: -0.15mm; }
          .barcode-test-note { position: absolute; right: ${preset.marginXmm}mm; bottom: 1.5mm; left: ${preset.marginXmm}mm; text-align: center; font: 7pt/1.2 sans-serif; color: #52525b; }
          svg rect { shape-rendering: crispEdges; }
        }
      `}</style>

      <div className="label-workspace-screen mx-auto max-w-[1440px] space-y-3 px-2 pb-8 sm:px-4">
        <div className="flex flex-col gap-2 border-b py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-2.5">
            <Button asChild variant="ghost" size="icon" className="mt-0.5 h-8 w-8 shrink-0">
              <Link to="/admin/inventory" search={{ section: "variants" }} aria-label="Back to inventory">
                <ArrowLeft className="h-4 w-4" />
              </Link>
            </Button>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-tight">Barcode labels</h1>
              <p className="text-sm text-muted-foreground">Select exact SKUs, set counts, and print a ready-to-cut sheet or thermal roll.</p>
            </div>
          </div>
          <div className="flex items-center gap-2 self-end sm:self-auto">
            <div className="hidden text-right text-xs text-muted-foreground sm:block">
              <div>{formatLabelCount(Math.min(copies.length, MAX_LABEL_COPIES))}</div>
              <div>{formatPageCount(pages.length)}</div>
            </div>
            <Button type="button" variant="outline" size="sm" disabled={!canPrint} onClick={() => startPrint("test")}>
              <FileText className="mr-1.5 h-3.5 w-3.5" /> Test page
            </Button>
            <Button type="button" size="sm" disabled={!canPrint} onClick={() => startPrint("job")}>
              <Printer className="mr-1.5 h-3.5 w-3.5" /> Print or save PDF
            </Button>
          </div>
        </div>

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_370px]">
          <div className="min-w-0 space-y-3">
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 px-3 py-2.5">
                <div>
                  <CardTitle className="text-sm">Selected SKUs <Badge variant="secondary" className="ml-1.5 px-1.5 py-0 text-[10px]">{selectedVariantIds.length}/{MAX_LABEL_SKUS}</Badge></CardTitle>
                </div>
                {selectedVariants.length > 0 ? (
                  <div className="flex items-center gap-1">
                    <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" title="Set every selected SKU to one label" onClick={() => setAllQuantities("one")}>One each</Button>
                    <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" title="Match tracked SKUs to on-hand stock; keep manual counts for untracked SKUs" onClick={() => setAllQuantities("onHand")}>On hand</Button>
                    <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" title="Match tracked SKUs to available stock; keep manual counts for untracked SKUs" onClick={() => setAllQuantities("available")}>Available</Button>
                  </div>
                ) : null}
              </CardHeader>
              <CardContent className="border-t p-0">
                {previewQuery.isError ? (
                  <div className="p-6 text-center text-sm text-destructive">Selected SKU details could not be loaded.</div>
                ) : previewQuery.isLoading ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">Loading selected SKUs…</div>
                ) : selectedVariants.length === 0 ? (
                  <div className="p-6 text-center">
                    <p className="text-sm font-medium">No SKUs selected</p>
                    <p className="mt-1 text-xs text-muted-foreground">Use the picker below. Each saved SKU already has its own scan identity.</p>
                  </div>
                ) : (
                  <div className="divide-y">
                    {selectedVariants.map((variant) => {
                      const symbol = resolveBarcodeSymbol(variant.barcode, variant.barcodeType);
                      const fitIssue = (quantities[variant.id] ?? 0) > 0 ? getBarcodeFitIssue(symbol, preset) : null;
                      return (
                        <div key={variant.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 px-3 py-2">
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate text-sm font-medium">{variant.productName}</span>
                              {variant.optionLabel ? <span className="truncate text-xs text-muted-foreground">· {variant.optionLabel}</span> : null}
                            </div>
                            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                              <span className="font-mono">{variant.sku}</span>
                              <span className="font-mono">{variant.barcode ?? "No barcode"}</span>
                              <span>{variant.barcodeType?.toUpperCase() ?? "UNPRINTABLE"}</span>
                              <span>{getLabelInventorySummary(variant)}</span>
                            </div>
                            {fitIssue ? <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">{fitIssue}</p> : null}
                          </div>
                          <QuantityControl
                            value={quantities[variant.id] ?? 1}
                            label={`${variant.productName} ${variant.optionLabel ?? variant.sku}`}
                            onChange={(value) => setQuantities((current) => ({ ...current, [variant.id]: value }))}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            aria-label={`Remove ${variant.productName} ${variant.optionLabel ?? variant.sku}`}
                            onClick={() => updateSelected(variant.id, false)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
                {previewQuery.data?.missingVariantIds.length ? (
                  <div className="border-t bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                    {previewQuery.data.missingVariantIds.length} selected {previewQuery.data.missingVariantIds.length === 1 ? "SKU is" : "SKUs are"} no longer printable and were skipped.
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="px-3 py-2.5">
                <CardTitle className="text-sm">Add SKUs</CardTitle>
              </CardHeader>
              <CardContent className="border-t p-0">
                <div className="border-b p-2.5">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      type="search"
                      value={searchInput}
                      onChange={(event) => { setSearchInput(event.target.value); setSearchPage(1); }}
                      placeholder="Find product, SKU, or barcode…"
                      aria-label="Find SKUs for barcode labels"
                      className="h-8 pl-8 text-sm"
                    />
                  </div>
                </div>
                {pickerQuery.isError ? (
                  <div className="p-5 text-center text-sm text-destructive">SKUs could not be loaded.</div>
                ) : pickerQuery.isLoading ? (
                  <div className="p-5 text-center text-sm text-muted-foreground">Loading SKUs…</div>
                ) : pickerVariants.length === 0 ? (
                  <div className="p-5 text-center text-sm text-muted-foreground">No matching SKUs.</div>
                ) : (
                  <div className="divide-y">
                    {pickerVariants.map((variant) => {
                      const selected = selectedVariantIds.includes(variant.id);
                      return (
                        <label key={variant.id} className="flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-muted/50">
                          <Checkbox checked={selected} onCheckedChange={(checked) => updateSelected(variant.id, checked === true)} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{variant.productName}</span>
                            <span className="block truncate text-xs text-muted-foreground">{variant.optionLabel || "Default SKU"} · <span className="font-mono">{variant.sku}</span></span>
                          </span>
                          {selected ? <Check className="h-4 w-4 text-emerald-600" /> : <Plus className="h-4 w-4 text-muted-foreground" />}
                        </label>
                      );
                    })}
                  </div>
                )}
                {pickerPagination && pickerPagination.totalPages > 1 ? (
                  <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
                    <span>{pickerPagination.total} SKUs</span>
                    <div className="flex items-center gap-1">
                      <Button type="button" variant="outline" size="icon" className="h-7 w-7" disabled={searchPage <= 1} onClick={() => setSearchPage((page) => Math.max(1, page - 1))} aria-label="Previous SKU page"><ChevronLeft className="h-3.5 w-3.5" /></Button>
                      <span className="min-w-16 text-center">{searchPage} / {pickerPagination.totalPages}</span>
                      <Button type="button" variant="outline" size="icon" className="h-7 w-7" disabled={searchPage >= pickerPagination.totalPages} onClick={() => setSearchPage((page) => Math.min(pickerPagination.totalPages, page + 1))} aria-label="Next SKU page"><ChevronRight className="h-3.5 w-3.5" /></Button>
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </div>

          <aside className="min-w-0 space-y-3 xl:sticky xl:top-3 xl:self-start">
            <Card>
              <CardHeader className="px-3 py-2.5"><CardTitle className="text-sm">Format</CardTitle></CardHeader>
              <CardContent className="space-y-3 border-t p-3">
                <div className="space-y-1.5">
                  <Label htmlFor="barcode-label-preset" className="text-xs">Paper or roll</Label>
                  <Select value={presetId} onValueChange={(value) => setPresetId(value as LabelPresetId)}>
                    <SelectTrigger id="barcode-label-preset" className="h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {LABEL_PRESETS.map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.detail}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                {presetId === "custom" ? (
                  <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/20 p-2.5">
                    <MillimetreInput id="custom-page-width" label="Page width" value={customPreset.pageWidthMm} min={20} max={320} step={0.5} onChange={(value) => setCustomPreset((current) => ({ ...current, pageWidthMm: value }))} />
                    <MillimetreInput id="custom-page-height" label="Page height" value={customPreset.pageHeightMm} min={15} max={450} step={0.5} onChange={(value) => setCustomPreset((current) => ({ ...current, pageHeightMm: value }))} />
                    <div className="space-y-1">
                      <Label htmlFor="custom-columns" className="text-[11px] font-normal text-muted-foreground">Columns</Label>
                      <Input id="custom-columns" type="number" min={1} max={10} value={customPreset.columns} onChange={(event) => setCustomPreset((current) => ({ ...current, columns: Math.max(1, Math.min(10, Math.trunc(event.target.valueAsNumber || 1))) }))} className="h-8 text-sm tabular-nums" />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="custom-rows" className="text-[11px] font-normal text-muted-foreground">Rows</Label>
                      <Input id="custom-rows" type="number" min={1} max={20} value={customPreset.rows} onChange={(event) => setCustomPreset((current) => ({ ...current, rows: Math.max(1, Math.min(20, Math.trunc(event.target.valueAsNumber || 1))) }))} className="h-8 text-sm tabular-nums" />
                    </div>
                    <MillimetreInput id="custom-margin-x" label="Side margin" value={customPreset.marginXmm} min={0} max={30} step={0.5} onChange={(value) => setCustomPreset((current) => ({ ...current, marginXmm: value }))} />
                    <MillimetreInput id="custom-margin-y" label="Vertical margin" value={customPreset.marginYmm} min={0} max={30} step={0.5} onChange={(value) => setCustomPreset((current) => ({ ...current, marginYmm: value }))} />
                    <MillimetreInput id="custom-gap-x" label="Column gap" value={customPreset.gapXmm} min={0} max={20} step={0.5} onChange={(value) => setCustomPreset((current) => ({ ...current, gapXmm: value }))} />
                    <MillimetreInput id="custom-gap-y" label="Row gap" value={customPreset.gapYmm} min={0} max={20} step={0.5} onChange={(value) => setCustomPreset((current) => ({ ...current, gapYmm: value }))} />
                    <div className="col-span-2 flex items-center justify-between border-t pt-2">
                      <Label htmlFor="custom-crop-marks" className="text-xs font-normal">Cut guides</Label>
                      <Switch id="custom-crop-marks" checked={customPreset.cropMarks} onCheckedChange={(cropMarks) => setCustomPreset((current) => ({ ...current, cropMarks }))} />
                    </div>
                  </div>
                ) : null}
                {capacity > 1 ? (
                  <div className="flex items-center justify-between gap-3 rounded-md border px-2.5 py-2">
                    <div className="min-w-0">
                      <Label htmlFor="barcode-start-cell" className="text-xs">Start at cell</Label>
                      <p className="truncate text-[10px] text-muted-foreground">{startOffset === 0 ? "New sheet" : `Skip ${startOffset} already-used ${startOffset === 1 ? "label" : "labels"}`}</p>
                    </div>
                    <Input
                      id="barcode-start-cell"
                      type="number"
                      min={1}
                      max={capacity}
                      value={startOffset + 1}
                      onChange={(event) => setStartOffset(Math.max(0, Math.min(capacity - 1, Math.trunc(event.target.valueAsNumber || 1) - 1)))}
                      className="h-8 w-20 text-center text-sm tabular-nums"
                    />
                  </div>
                ) : null}
                <div className="grid grid-cols-2 gap-x-3 gap-y-2 border-t pt-3">
                  {([
                    ["showProduct", "Product"],
                    ["showVariant", "Variant"],
                    ["showSku", "SKU"],
                    ["showPrice", "Selling price"],
                  ] as const).map(([key, label]) => (
                    <div key={key} className="flex items-center justify-between gap-2">
                      <Label htmlFor={`label-content-${key}`} className="text-xs font-normal">{label}</Label>
                      <Switch id={`label-content-${key}`} checked={content[key]} onCheckedChange={(checked) => setContent((current) => ({ ...current, [key]: checked }))} />
                    </div>
                  ))}
                </div>
                <div className="rounded-md bg-muted/60 px-2.5 py-2 text-xs text-muted-foreground">
                  <div className="flex items-center justify-between"><span>Page</span><span className="font-medium text-foreground">{preset.pageWidthMm} × {preset.pageHeightMm} mm</span></div>
                  <div className="mt-1 flex items-center justify-between"><span>Labels per page</span><span className="font-medium text-foreground">{preset.columns * preset.rows}</span></div>
                  {startOffset > 0 ? <div className="mt-1 flex items-center justify-between"><span>First label</span><span className="font-medium text-foreground">Cell {startOffset + 1}</span></div> : null}
                  <div className="mt-1 flex items-center justify-between"><span>Output</span><span className="font-medium text-foreground">{formatLabelCount(Math.min(copies.length, MAX_LABEL_COPIES))} · {formatPageCount(pages.length)}</span></div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 px-3 py-2.5">
                <CardTitle className="text-sm">Page preview</CardTitle>
                <span className="text-[11px] text-muted-foreground">{capacity > 1 ? "Click a cell to start" : "Print at 100%"}</span>
              </CardHeader>
              <CardContent className="border-t bg-zinc-100 p-4 dark:bg-zinc-950">
                {pages[0]?.length ? (
                  <PaperPreview
                    page={pages[0]}
                    preset={preset}
                    content={content}
                    formatPrice={formatPrice}
                    startOffset={startOffset}
                    onStartOffsetChange={setStartOffset}
                  />
                ) : <div className="grid aspect-[210/297] place-items-center border border-dashed bg-white text-center text-xs text-zinc-500">Select a SKU and set at least one label.</div>}
              </CardContent>
            </Card>

            {presetIssue ? (
              <div className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {presetIssue}
              </div>
            ) : tooManyCopies ? (
              <div className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> A print job is limited to {MAX_LABEL_COPIES} labels. Reduce the quantities before printing.
              </div>
            ) : activeFitIssues.length > 0 ? (
              <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{activeFitIssues.length} {activeFitIssues.length === 1 ? "barcode does" : "barcodes do"} not safely fit this format. Choose a wider label or set that SKU’s count to zero.</span>
                </div>
                {compatiblePreset ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 shrink-0 border-amber-400 bg-white px-2 text-xs text-amber-950 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100 dark:hover:bg-amber-900"
                    onClick={() => setPresetId(compatiblePreset.id)}
                  >
                    Use {compatiblePreset.name}
                  </Button>
                ) : null}
              </div>
            ) : copies.length > 0 ? (
              <div className="flex gap-2 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
                <Check className="mt-0.5 h-4 w-4 shrink-0" /> Ready. Print a test page at Actual size / 100%, then scan its first label before the full batch.
              </div>
            ) : null}
          </aside>
        </div>
      </div>

      {canPrint && printMode ? (
        <PrintPages pages={pages} preset={preset} content={content} formatPrice={formatPrice} test={printMode === "test"} />
      ) : null}
    </>
  );
}
