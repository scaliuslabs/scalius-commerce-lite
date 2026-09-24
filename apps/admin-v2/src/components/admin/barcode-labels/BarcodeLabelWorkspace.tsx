import JsBarcode from "jsbarcode";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Plus, Printer, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { postApiV1AdminInventoryLabelsPreview } from "@scalius/api-client/sdk";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { Switch } from "~/components/ui/switch";
import { useCurrency } from "~/hooks/use-currency";
import { useDebounce } from "~/hooks/use-debounce";
import { apiData } from "~/lib/api";
import { fetchInventory, type InventoryLabelVariant } from "~/lib/api-query-options/inventory";
import { withDashboardBasePath } from "~/lib/dashboard-base-path";
import { cn } from "@scalius/shared/utils";
import { formatNumber, useLocale, useMessages } from "~/i18n";
import { inventoryMessages } from "~/i18n/inventory";
import { resourceMessages } from "~/i18n/resource";
import {
  buildLabelCopies,
  countLabelPages,
  DEFAULT_LABEL_CONTENT,
  findCompatibleLabelPreset,
  getBarcodeFitIssue,
  getBarcodeQuietZoneModules,
  getLabelPreset,
  getLabelShortcutQuantity,
  LABEL_PRESETS,
  MAX_LABEL_COPIES,
  MAX_LABEL_SKUS,
  resolveBarcodeSymbol,
  type BarcodeSymbol,
  type LabelContentOptions,
  type LabelPresetId,
  type LabelQuantityShortcut,
} from "./barcode-label-model";

const PREFERENCE_KEY = "scalius:barcode-label-preferences:v1";
const CONTENT_OPTIONS = ["showProduct", "showVariant", "showSku", "showPrice"] as const;

type Preferences = { presetId: LabelPresetId; content: LabelContentOptions };

function readPreferences(): Preferences {
  const fallback: Preferences = { presetId: "a4", content: DEFAULT_LABEL_CONTENT };
  try {
    const saved = JSON.parse(window.localStorage.getItem(PREFERENCE_KEY) ?? "{}") as Partial<Preferences>;
    return {
      presetId: LABEL_PRESETS.some((preset) => preset.id === saved.presetId) ? saved.presetId! : fallback.presetId,
      content: { ...DEFAULT_LABEL_CONTENT, ...saved.content },
    };
  } catch {
    return fallback;
  }
}

function variantName(variant: Pick<InventoryLabelVariant, "productName" | "optionLabel">): string {
  return variant.optionLabel ? `${variant.productName} · ${variant.optionLabel}` : variant.productName;
}

function BarcodeGraphic({ symbol }: { symbol: BarcodeSymbol }) {
  const t = useMessages(inventoryMessages);
  const ref = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (!ref.current || !symbol.format || symbol.error) return;
    try {
      const quietZone = getBarcodeQuietZoneModules(symbol.format);
      JsBarcode(ref.current, symbol.value, {
        format: symbol.format,
        displayValue: false,
        margin: 0,
        marginLeft: quietZone.left * 2,
        marginRight: quietZone.right * 2,
        width: 2,
        height: 54,
        background: "transparent",
        lineColor: "currentColor",
      });
      ref.current.setAttribute("preserveAspectRatio", "xMidYMid meet");
      ref.current.removeAttribute("width");
      ref.current.removeAttribute("height");
    } catch {
      ref.current.replaceChildren();
    }
  }, [symbol]);

  if (!symbol.format || symbol.error) {
    return <p className="py-3 text-body text-muted-foreground">{t("noBarcode")}</p>;
  }
  return <svg ref={ref} aria-label={t("barcode", { value: symbol.displayValue })} className="block h-12 w-full" />;
}

/** Placeholder rows the same height as a loaded row (two text lines, py-3). */
function LoadingRows({ count }: { count: number }) {
  const t = useMessages(inventoryMessages);
  return (
    <ul role="status" aria-label={t("loading")} className="divide-y">
      {Array.from({ length: Math.max(1, count) }, (_, row) => (
        <li key={row} className="space-y-1 py-3">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
        </li>
      ))}
    </ul>
  );
}

type BarcodeLabelWorkspaceProps = {
  selectedVariantIds: string[];
  onSelectedVariantIdsChange: (ids: string[]) => void;
};

export function BarcodeLabelWorkspace({
  selectedVariantIds,
  onSelectedVariantIdsChange,
}: BarcodeLabelWorkspaceProps) {
  const t = useMessages(inventoryMessages);
  const r = useMessages(resourceMessages);
  const { fmt } = useCurrency();
  const locale = useLocale();
  const [preferences, setPreferences] = useState(readPreferences);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [searchPage, setSearchPage] = useState(1);
  const search = useDebounce(searchInput, 250);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const { presetId, content } = preferences;
  const preset = getLabelPreset(presetId);

  useEffect(() => {
    try {
      window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify(preferences));
    } catch {
      // Blocked storage only forgets the choice for next time.
    }
  }, [preferences]);

  const previewQuery = useQuery({
    queryKey: ["inventory", "label-preview", selectedVariantIds],
    queryFn: () => apiData(postApiV1AdminInventoryLabelsPreview({ body: { variantIds: selectedVariantIds } })),
    enabled: selectedVariantIds.length > 0,
    staleTime: 30_000,
  });

  const pickerQuery = useQuery({
    queryKey: ["inventory", "label-picker", search, searchPage],
    queryFn: () => fetchInventory({
      section: "variants",
      search: search || undefined,
      page: searchPage,
      limit: 20,
      sort: "productName",
      order: "asc",
    }),
    enabled: pickerOpen,
    staleTime: 30_000,
  });

  const selectedVariants = useMemo(() => previewQuery.data?.variants ?? [], [previewQuery.data]);
  useEffect(() => {
    setQuantities((current) => {
      const missing = selectedVariants.filter((variant) => current[variant.id] === undefined);
      return missing.length === 0
        ? current
        : { ...current, ...Object.fromEntries(missing.map((variant) => [variant.id, 1])) };
    });
  }, [selectedVariants]);

  const copies = useMemo(() => buildLabelCopies(selectedVariants, quantities), [selectedVariants, quantities]);
  const fitIssues = useMemo(() => new Map(selectedVariants.flatMap((variant) => {
    if ((quantities[variant.id] ?? 0) <= 0) return [];
    const issue = getBarcodeFitIssue(resolveBarcodeSymbol(variant.barcode, variant.barcodeType), preset);
    return issue ? [[variant.id, issue] as const] : [];
  })), [preset, quantities, selectedVariants]);
  const compatiblePreset = fitIssues.size > 0
    ? findCompatibleLabelPreset(
        selectedVariants
          .filter((variant) => (quantities[variant.id] ?? 0) > 0)
          .map((variant) => resolveBarcodeSymbol(variant.barcode, variant.barcodeType)),
        preset,
      )
    : null;
  const tooMany = copies.length > MAX_LABEL_COPIES;
  const canPrint = copies.length > 0 && !tooMany && fitIssues.size === 0;
  const labelCount = Math.min(copies.length, MAX_LABEL_COPIES);
  const pageCount = countLabelPages(labelCount, preset);
  const firstCopy = copies[0];
  const pickerVariants = pickerQuery.data?.variants ?? [];
  const pickerPages = pickerQuery.data?.pagination?.totalPages ?? 1;

  const setContent = (key: keyof LabelContentOptions, value: boolean) =>
    setPreferences((current) => ({ ...current, content: { ...current.content, [key]: value } }));

  const toggleVariant = (id: string, selected: boolean) => {
    if (selected) {
      if (selectedVariantIds.length < MAX_LABEL_SKUS && !selectedVariantIds.includes(id)) {
        onSelectedVariantIdsChange([...selectedVariantIds, id]);
      }
      return;
    }
    setQuantities((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    onSelectedVariantIdsChange(selectedVariantIds.filter((candidate) => candidate !== id));
  };

  const setAllQuantities = (mode: LabelQuantityShortcut) => {
    setQuantities((current) => ({
      ...current,
      ...Object.fromEntries(selectedVariants.map((variant) => [
        variant.id,
        getLabelShortcutQuantity(variant, current[variant.id] ?? 1, mode),
      ])),
    }));
  };

  const print = async () => {
    if (printing || !canPrint) return;
    // Open the tab inside the click so pop-up blockers allow it.
    const printWindow = window.open("about:blank", "_blank");
    if (!printWindow) {
      setPrintError(t("popupBlocked"));
      return;
    }
    printWindow.opener = null;
    setPrintError(null);
    setPrinting(true);
    try {
      const variantIds = selectedVariants.map((variant) => variant.id);
      const response = await fetch(withDashboardBasePath("/api/v1/admin/inventory/labels/artifact"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format: "html",
          mode: "job",
          // Printed prices use the same format as the preview.
          locale,
          variantIds,
          quantities: Object.fromEntries(variantIds.map((id) => [id, quantities[id] ?? 0])),
          order: "selected",
          preset,
          startOffset: 0,
          alignment: { xMm: 0, yMm: 0 },
          content,
        }),
      });
      if (!response.ok) throw new Error("print failed");
      const url = URL.createObjectURL(await response.blob());
      printWindow.location.href = url;
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      printWindow.close();
      setPrintError(t("printFailed"));
    } finally {
      setPrinting(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title={t("labelsTitle")} backTo="/admin/inventory" />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>
                {t("labels")}{" "}
                <span className="text-body font-normal text-muted-foreground">
                  {t("labelsOf", { count: selectedVariantIds.length, max: MAX_LABEL_SKUS })}
                </span>
              </CardTitle>
              <Button type="button" variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
                <Plus />
                {t("addVariants")}
              </Button>
            </div>
            {selectedVariants.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setAllQuantities("one")}>{t("oneEach")}</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setAllQuantities("onHand")}>{t("matchOnHand")}</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setAllQuantities("available")}>{t("matchAvailable")}</Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setQuantities({});
                    onSelectedVariantIdsChange([]);
                  }}
                >
                  {t("clearAll")}
                </Button>
              </div>
            ) : null}
          </CardHeader>
          <CardContent>
            {previewQuery.isError ? (
              <p className="text-body text-destructive">{r("loadFailed")}</p>
            ) : previewQuery.isLoading ? (
              <LoadingRows count={Math.min(selectedVariantIds.length, 5)} />
            ) : selectedVariants.length === 0 ? (
              <div className="py-6 text-center">
                <p className="text-body font-medium">{t("noneSelected")}</p>
                <p className="text-body text-muted-foreground">{t("noneSelectedHint")}</p>
              </div>
            ) : (
              <ul className="divide-y">
                {selectedVariants.map((variant) => {
                  const name = variantName(variant);
                  const issue = fitIssues.get(variant.id);
                  return (
                    <li key={variant.id} className="flex flex-wrap items-center gap-3 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-body font-medium">{name}</p>
                        <p className="text-body text-muted-foreground">
                          <span className="break-all font-mono">{variant.sku}</span>
                          {" · "}
                          {variant.barcode ? <span className="font-mono">{variant.barcode}</span> : t("noBarcode")}
                          {" · "}
                          {variant.trackInventory
                            ? t("stockSummary", { onHand: variant.stock, available: variant.available })
                            : t("notTracked")}
                        </p>
                        {issue ? (
                          <p className="text-body text-destructive">
                            {t(issue === "tooWide" ? "barcodeTooWide" : "barcodeUnprintable")}
                          </p>
                        ) : null}
                      </div>
                      <Input
                        type="number"
                        min={0}
                        max={MAX_LABEL_COPIES}
                        inputMode="numeric"
                        className="w-20"
                        aria-label={t("labelsFor", { name })}
                        value={quantities[variant.id] ?? 1}
                        onChange={(event) => {
                          const value = Math.max(0, Math.min(MAX_LABEL_COPIES, Math.trunc(event.target.valueAsNumber || 0)));
                          setQuantities((current) => ({ ...current, [variant.id]: value }));
                        }}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t("removeFor", { name })}
                        onClick={() => toggleVariant(variant.id, false)}
                      >
                        <Trash2 />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            {previewQuery.data?.missingVariantIds.length ? (
              <p className="pt-3 text-body text-muted-foreground">
                {t("skipped", { count: previewQuery.data.missingVariantIds.length })}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t("labelSize")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Select
                value={presetId}
                onValueChange={(value) => setPreferences((current) => ({ ...current, presetId: value as LabelPresetId }))}
              >
                <SelectTrigger className="w-full" aria-label={t("labelSize")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LABEL_PRESETS.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>{t(`preset_${candidate.id}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <fieldset className="space-y-3">
                <legend className="pb-2 text-body font-medium">{t("showOnLabel")}</legend>
                {CONTENT_OPTIONS.map((key) => (
                  <div key={key} className="flex items-center justify-between gap-2">
                    <Label htmlFor={`label-content-${key}`}>{t(key)}</Label>
                    <Switch
                      id={`label-content-${key}`}
                      checked={content[key]}
                      onCheckedChange={(checked) => setContent(key, checked)}
                    />
                  </div>
                ))}
              </fieldset>

              <div className="space-y-2 border-t pt-4">
                <p className="text-body font-medium" aria-live="polite">
                  {labelCount === 1 ? t("labelCountOne") : t("labelCount", { count: labelCount })}
                  {" · "}
                  {pageCount === 1 ? t("pageCountOne") : t("pageCount", { count: pageCount })}
                </p>
                {tooMany ? (
                  <p className="text-body text-destructive">{t("tooManyLabels", { max: MAX_LABEL_COPIES })}</p>
                ) : fitIssues.size > 0 ? (
                  <div className="space-y-2">
                    <p className="text-body text-destructive">{t("fitIssues", { count: fitIssues.size })}</p>
                    {compatiblePreset ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setPreferences((current) => ({ ...current, presetId: compatiblePreset.id }))}
                      >
                        {t("usePreset", { name: t(`preset_${compatiblePreset.id}`) })}
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-body text-muted-foreground">{t("printHint")}</p>
                )}
                {printError ? <p role="alert" className="text-body text-destructive">{printError}</p> : null}
                <Button type="button" className="w-full" disabled={!canPrint || printing} onClick={() => void print()}>
                  <Printer />
                  {printing ? t("preparing") : t("print")}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("preview")}</CardTitle>
            </CardHeader>
            <CardContent>
              {firstCopy ? (
                // No overflow clipping: the box keeps its label shape and grows rather than cut the price.
                <div
                  className={cn(
                    "flex flex-col justify-center gap-1 rounded-md bg-muted p-3 text-center",
                    preset.id === "a4" ? "aspect-2/1" : "aspect-3/2",
                  )}
                >
                  <BarcodeGraphic symbol={firstCopy.symbol} />
                  <p className="truncate font-mono text-body">{firstCopy.symbol.displayValue}</p>
                  {content.showProduct ? <p className="truncate text-body font-medium">{firstCopy.variant.productName}</p> : null}
                  {content.showVariant && firstCopy.variant.optionLabel ? (
                    <p className="truncate text-body">{firstCopy.variant.optionLabel}</p>
                  ) : null}
                  {content.showSku || content.showPrice ? (
                    <p className="text-body">
                      {content.showSku ? <span className="break-all">{firstCopy.variant.sku}</span> : null}
                      {content.showSku && content.showPrice ? " · " : null}
                      {content.showPrice ? <span className="whitespace-nowrap">{fmt(firstCopy.variant.effectivePrice)}</span> : null}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="text-body text-muted-foreground">{t("previewEmpty")}</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("addVariants")}</DialogTitle>
          </DialogHeader>
          <Input
            type="search"
            value={searchInput}
            onChange={(event) => {
              setSearchInput(event.target.value);
              setSearchPage(1);
            }}
            placeholder={t("searchVariants")}
            aria-label={r("search")}
          />
          <div className="max-h-96 overflow-y-auto">
            {pickerQuery.isError ? (
              <p className="py-4 text-body text-destructive">{r("loadFailed")}</p>
            ) : pickerQuery.isLoading ? (
              <LoadingRows count={5} />
            ) : pickerVariants.length === 0 ? (
              <p className="py-4 text-body text-muted-foreground">{r("noResults")}</p>
            ) : (
              <ul className="divide-y">
                {pickerVariants.map((variant) => {
                  const selected = selectedVariantIds.includes(variant.id);
                  // A simple product's hidden default SKU is just the product.
                  const name = variantName({ productName: variant.productName ?? t("unknownProduct"), optionLabel: variant.optionLabel });
                  return (
                    <li key={variant.id}>
                      <label className="flex cursor-pointer items-center gap-3 py-3">
                        <Checkbox
                          checked={selected}
                          onCheckedChange={(checked) => toggleVariant(variant.id, checked === true)}
                          aria-label={t("toggleVariant", { name })}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block break-words text-body font-medium">{name}</span>
                          <span className="block break-all font-mono text-body text-muted-foreground">{variant.sku}</span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <DialogFooter className="items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={r("previous")}
                disabled={searchPage <= 1}
                onClick={() => setSearchPage((page) => Math.max(1, page - 1))}
              >
                <ChevronLeft />
              </Button>
              <span className="text-body text-muted-foreground">
                {t("pickerPage", { page: searchPage, pages: formatNumber(pickerPages) })}
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={r("next")}
                disabled={searchPage >= pickerPages}
                onClick={() => setSearchPage((page) => Math.min(pickerPages, page + 1))}
              >
                <ChevronRight />
              </Button>
            </div>
            <Button type="button" onClick={() => setPickerOpen(false)}>{r("confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
