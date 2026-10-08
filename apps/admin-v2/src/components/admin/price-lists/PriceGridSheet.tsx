// The price grid (Medusa's "Edit prices"): each SKU of the list with its
// price for one unit, an optional compare-at price and up to four quantity
// breaks, in the list's currency. Pages and search work as on the page; edits
// are kept across pages until saved. One save sends at most 100 SKUs under
// the list's revision. Loaded on first use (React.lazy).
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search, Trash2, X } from "lucide-react";
import { toast } from "~/lib/toast";
import { SkuPicker } from "~/components/admin/purchasing/SkuPicker";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { MoneyInput } from "~/components/admin/shared/MoneyInput";
import { useDirtyDialogClose } from "~/components/admin/shared/use-dirty-dialog-close";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NumberInput } from "~/components/ui/number-input";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import { Skeleton } from "~/components/ui/skeleton";
import { useCurrency } from "~/hooks/use-currency";
import { useDebounce } from "~/hooks/use-debounce";
import { formatNumber, useMessages } from "~/i18n";
import { priceListMessages } from "~/i18n/price-lists";
import { getServerFnError } from "~/lib/api-helpers";
import {
  PRICE_LIST_PAGE_SIZE,
  priceListPricesQueryOptions,
  useSavePriceListPrices,
  type PriceList,
} from "~/lib/api-query-options/price-lists";
import {
  canAddBreak,
  gridChanges,
  gridRow,
  gridRowProblem,
  newGridRow,
  nextBreak,
  rowChanged,
  type GridRow,
} from "./price-list-form";

/** At most this many SKUs per save (the API's limit). */
const WRITE_MAX = 100;

export function PriceGridSheet({ open, onOpenChange, list, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  list: PriceList;
  onSaved: (list: PriceList) => void;
}) {
  const t = useMessages(priceListMessages);
  const [page, setPage] = useState(1);
  const [typed, setTyped] = useState("");
  const search = useDebounce(typed.trim(), 300);
  // Rows as loaded (the baseline), the merchant's edits and additions, and removals.
  const [loaded, setLoaded] = useState(() => new Map<string, GridRow>());
  const [edits, setEdits] = useState(() => new Map<string, GridRow>());
  const [added, setAdded] = useState<string[]>([]);
  const [removed, setRemoved] = useState(() => new Set<string>());
  const prices = useQuery({ ...priceListPricesQueryOptions(list.id, page, search), enabled: open });
  const save = useSavePriceListPrices(list.id);

  const pageRows = useMemo(() => (prices.data?.items ?? []).map(gridRow), [prices.data]);
  const baseline = useMemo(() => {
    const next = new Map(loaded);
    for (const row of pageRows) if (!next.has(row.variantId)) next.set(row.variantId, row);
    return next;
  }, [loaded, pageRows]);
  const changed = [...edits.values()].filter((row) => rowChanged(baseline.get(row.variantId), row));
  const changeCount = changed.length + [...removed].filter((id) => baseline.has(id)).length;
  const dirty = changeCount > 0;
  const invalid = changed.some((row) => gridRowProblem(row) !== null);
  const tooMany = changeCount > WRITE_MAX;

  const reset = () => {
    setLoaded(new Map());
    setEdits(new Map());
    setAdded([]);
    setRemoved(new Set());
    setTyped("");
    setPage(1);
    save.reset();
  };
  const close = () => {
    onOpenChange(false);
    reset();
  };
  const { requestClose, discardDialog } = useDirtyDialogClose({ dirty, busy: save.isPending, onClose: close });

  const rowOf = (row: GridRow) => edits.get(row.variantId) ?? row;
  // Keep the loaded version as the baseline once a row is touched, so it outlives its page.
  const keepBaseline = (variantId: string) => {
    const original = baseline.get(variantId);
    if (original && !loaded.has(variantId)) setLoaded((current) => new Map(current).set(variantId, original));
  };
  const change = (row: GridRow) => {
    keepBaseline(row.variantId);
    setEdits((current) => new Map(current).set(row.variantId, row));
  };
  const remove = (row: GridRow) => {
    keepBaseline(row.variantId);
    setEdits((current) => {
      const next = new Map(current);
      next.delete(row.variantId);
      return next;
    });
    if (added.includes(row.variantId)) {
      setAdded((current) => current.filter((id) => id !== row.variantId));
      return;
    }
    setRemoved((current) => new Set(current).add(row.variantId));
  };

  const listed = new Set([...pageRows.map((row) => row.variantId), ...added]);
  const addedRows = added.map((id) => edits.get(id)).filter((row): row is GridRow => Boolean(row));
  const shownRows = [...addedRows, ...pageRows.filter((row) => !removed.has(row.variantId) && !added.includes(row.variantId)).map(rowOf)];
  const pages = Math.max(1, Math.ceil((prices.data?.total ?? 0) / PRICE_LIST_PAGE_SIZE));

  const submit = () => {
    if (!dirty || invalid || tooMany) return;
    save.mutate(gridChanges([...baseline.values()], changed, [...removed], list.revision), {
      onSuccess: (next) => {
        toast.success(t("pricesSaved"));
        onSaved(next);
        close();
      },
    });
  };

  return (
    <>
      <Sheet open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
        <SheetContent className="flex flex-col gap-0 p-0 sm:max-w-3xl">
          <div className="flex items-start gap-2 border-b p-6 pb-4">
            <SheetHeader className="min-w-0 flex-1">
              <SheetTitle>{t("gridTitle")}</SheetTitle>
              <SheetDescription>
                {t("gridDescription")} {t("pricesDescription", { currency: list.currencyCode })}
              </SheetDescription>
            </SheetHeader>
            <Button type="button" variant="ghost" size="icon" className="-me-2 -mt-2 shrink-0" aria-label={t("close")} onClick={requestClose}>
              <X className="size-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
            {save.error ? <Alert variant="destructive"><AlertDescription>{getServerFnError(save.error, t("pricesSaveFailed"))}</AlertDescription></Alert> : null}
            <div className="grid gap-2 sm:grid-cols-2">
              <SkuPicker
                id="price-grid-add"
                addedIds={listed}
                onPick={(variant) => {
                  const row = newGridRow(variant);
                  setRemoved((current) => {
                    const next = new Set(current);
                    next.delete(row.variantId);
                    return next;
                  });
                  if (baseline.has(row.variantId)) return;
                  setAdded((current) => [row.variantId, ...current]);
                  setEdits((current) => new Map(current).set(row.variantId, row));
                }}
              />
              <div className="relative">
                <Search aria-hidden="true" className="pointer-events-none absolute inset-s-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  aria-label={t("searchPrices")}
                  placeholder={t("searchPrices")}
                  // eslint-disable-next-line shadcn/no-restyle -- room for the search icon inside the field
                  className="ps-9"
                  value={typed}
                  onChange={(event) => {
                    setTyped(event.target.value);
                    setPage(1);
                  }}
                />
              </div>
            </div>
            {prices.isError ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-body">{t("loadPricesFailed")}</p>
                <Button variant="outline" size="sm" onClick={() => void prices.refetch()}>{t("retry")}</Button>
              </div>
            ) : prices.isPending ? (
              <div aria-busy className="space-y-2">{[0, 1, 2].map((index) => <Skeleton key={index} className="h-16 w-full" />)}</div>
            ) : shownRows.length === 0 ? (
              <p className="text-body text-muted-foreground">{search ? t("noMatch") : t("noPrices")}</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {shownRows.map((row) => (
                  <GridRowEditor
                    key={row.variantId}
                    row={row}
                    isNew={added.includes(row.variantId)}
                    currencyCode={list.currencyCode}
                    onChange={change}
                    onRemove={() => remove(row)}
                  />
                ))}
              </ul>
            )}
            {pages > 1 ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-body text-muted-foreground">{t("pageOf", { page: formatNumber(page), pages: formatNumber(pages) })}</p>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t("previous")}</Button>
                  <Button type="button" variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>{t("next")}</Button>
                </div>
              </div>
            ) : null}
          </div>
          <SheetFooter className="items-center">
            {dirty ? (
              <p className={tooMany ? "me-auto text-body text-destructive" : "me-auto text-body text-muted-foreground"}>
                {tooMany ? t("tooManyChanges", { count: WRITE_MAX }) : t("changes", { count: changeCount })}
              </p>
            ) : null}
            <Button type="button" variant="outline" disabled={save.isPending} onClick={requestClose}>{dirty ? t("discard") : t("close")}</Button>
            <Button type="button" disabled={!dirty || invalid || tooMany} loading={save.isPending} onClick={submit}>{t("savePrices")}</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      <ConfirmDialog {...discardDialog} />
    </>
  );
}

function GridRowEditor({ row, isNew, currencyCode, onChange, onRemove }: {
  row: GridRow;
  isNew: boolean;
  currencyCode: string;
  onChange: (row: GridRow) => void;
  onRemove: () => void;
}) {
  const t = useMessages(priceListMessages);
  const { fmt } = useCurrency();
  const problem = gridRowProblem(row);
  const id = `price-grid-${row.variantId}`;
  const name = [row.productName, row.variantLabel].filter(Boolean).join(" · ");
  const set = (patch: Partial<GridRow>) => onChange({ ...row, ...patch });
  return (
    <li className="space-y-3 p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-body font-medium">
            <span className="break-words">{name}</span>
            {isNew ? <Badge variant="info">{t("newSku")}</Badge> : null}
          </p>
          <p className="text-body text-muted-foreground">{row.sku} · {t("basePrice")}: {fmt(row.basePrice)}</p>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t("removeSku", { name })} onClick={onRemove}>
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor={`${id}-price`} className="text-body font-medium">{t("price")}</label>
          <MoneyInput
            id={`${id}-price`}
            currencyCode={currencyCode}
            value={row.amount}
            aria-invalid={problem === "priceRequired" ? true : undefined}
            onValueChange={(amount) => set({ amount })}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-compare`} className="text-body font-medium">{t("compareAt")}</label>
          <MoneyInput
            id={`${id}-compare`}
            currencyCode={currencyCode}
            value={row.compareAt}
            aria-invalid={problem === "compareAtAbove" ? true : undefined}
            onValueChange={(compareAt) => set({ compareAt })}
          />
        </div>
      </div>
      {row.breaks.length > 0 ? (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-body font-medium">{t("quantityBreaks")}</legend>
          {row.breaks.map((tier, index) => (
            <div key={tier.key} className="flex items-end gap-2">
              <div className="w-28 space-y-1.5">
                <label htmlFor={`${id}-break-${tier.key}-qty`} className="text-body text-muted-foreground">{t("breakUnits")}</label>
                <NumberInput
                  id={`${id}-break-${tier.key}-qty`}
                  integer
                  min={2}
                  value={tier.minQuantity}
                  onValueChange={(minQuantity) => set({ breaks: row.breaks.map((item, at) => (at === index ? { ...item, minQuantity } : item)) })}
                />
              </div>
              <div className="min-w-0 flex-1 space-y-1.5">
                <label htmlFor={`${id}-break-${tier.key}-price`} className="text-body text-muted-foreground">{t("breakPrice")}</label>
                <MoneyInput
                  id={`${id}-break-${tier.key}-price`}
                  currencyCode={currencyCode}
                  value={tier.amount}
                  onValueChange={(amount) => set({ breaks: row.breaks.map((item, at) => (at === index ? { ...item, amount } : item)) })}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("removeBreak")}
                onClick={() => set({ breaks: row.breaks.filter((_, at) => at !== index) })}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
          ))}
        </fieldset>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {canAddBreak(row) ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => set({ breaks: [...row.breaks, nextBreak(row)] })}>
            <Plus aria-hidden="true" />
            {t("addBreak")}
          </Button>
        ) : <span />}
        {problem ? <p role="alert" className="text-body text-destructive">{t(problem)}</p> : null}
      </div>
    </li>
  );
}
