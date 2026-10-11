import { useEffect, useRef, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { IndexPager } from "~/components/admin/data-table/DataTablePagination";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { useMessages } from "~/i18n";
import { purchasingMessages } from "~/i18n/purchasing";
import { resourceMessages } from "~/i18n/resource";

interface PurchasingLine {
  variantId: string;
  productName: string | null;
  optionLabel: string | null;
  sku: string;
  barcode?: string | null;
}

export interface PurchasingLineReveal {
  variantId: string;
  invalid: boolean;
}

/** Only the rendered lines are paged; the document and its edits stay with the parent. */
export function PurchasingLines<T extends PurchasingLine>({ lines, invalidIds, reveal, children }: {
  lines: readonly T[];
  invalidIds?: ReadonlySet<string>;
  reveal?: PurchasingLineReveal | null;
  children: (pageLines: readonly T[]) => ReactNode;
}) {
  const t = useMessages(purchasingMessages);
  const r = useMessages(resourceMessages);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [lastReveal, setLastReveal] = useState<PurchasingLineReveal | null>(null);
  const [pendingReveal, setPendingReveal] = useState<PurchasingLineReveal | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const needle = query.trim().toLowerCase();
  const matches = needle ? lines.filter(line =>
    [line.productName, line.optionLabel, line.sku, line.barcode].some(value => value?.toLowerCase().includes(needle))) : lines;
  const pages = Math.max(1, Math.ceil(matches.length / 50));
  const current = Math.min(page, pages - 1);
  if (page !== current) setPage(current);
  const start = current * 50;
  const visible = matches.slice(start, start + 50);
  const firstInvalid = lines.find(line => invalidIds?.has(line.variantId));
  const showSearch = lines.length > 50 || query.length > 0;

  const revealLine = (target: PurchasingLineReveal) => {
    const matchingIndex = matches.findIndex(line => line.variantId === target.variantId);
    const index = matchingIndex < 0 ? lines.findIndex(line => line.variantId === target.variantId) : matchingIndex;
    if (index < 0) return;
    if (matchingIndex < 0) setQuery("");
    setPage(Math.floor(index / 50));
    setPendingReveal(target);
  };
  // Only a new editor intent reveals a line; reloads or unrelated edits never move the page.
  if (reveal && reveal !== lastReveal) {
    setLastReveal(reveal);
    revealLine(reveal);
  }

  useEffect(() => {
    if (!pendingReveal) return;
    const row = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-purchasing-line]") ?? [])
      .find(element => element.dataset.purchasingLine === pendingReveal.variantId);
    row?.scrollIntoView({ block: "nearest" });
    row?.querySelector<HTMLInputElement>(pendingReveal.invalid ? 'input[aria-invalid="true"]' : "input")?.focus();
  }, [pendingReveal]);

  return (
    <div ref={root}>
      {showSearch || firstInvalid ? <div className="space-y-2 border-t px-4 py-3">
        {showSearch ? <Field label={t("searchLines")}>
          <Input type="search" prefix={<Search aria-hidden className="size-4" />} autoComplete="off"
            value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} />
        </Field> : null}
        {firstInvalid ? (
          <Button type="button" variant="outline" size="sm" onClick={() => {
            revealLine({ variantId: firstInvalid.variantId, invalid: true });
          }}>{r("fixFields")}</Button>
        ) : null}
      </div> : null}
      {visible.length > 0 ? children(visible) : (
        <p role="status" className="border-t px-4 py-6 text-center text-body text-muted-foreground">{r("noResults")}</p>
      )}
      {showSearch && matches.length > 0 ? (
        <IndexPager
          label={r("showing", { start: start + 1, end: start + visible.length, total: matches.length })}
          navLabel={r("page", { page: current + 1, pages })}
          canPrevious={current > 0} canNext={current < pages - 1}
          onPrevious={() => setPage(current - 1)} onNext={() => setPage(current + 1)}
        />
      ) : null}
    </div>
  );
}
