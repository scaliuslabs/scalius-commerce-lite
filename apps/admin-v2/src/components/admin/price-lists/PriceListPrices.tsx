// A price list's SKU prices, one page at a time: each SKU with its product
// price, its list price (and compare-at price) and its quantity breaks.
// Search finds a product or SKU; "Edit prices" opens the grid.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { useDebounce } from "~/hooks/use-debounce";
import { useCurrency } from "~/hooks/use-currency";
import { formatNumber, useMessages } from "~/i18n";
import { priceListMessages } from "~/i18n/price-lists";
import { PRICE_LIST_PAGE_SIZE, priceListPricesQueryOptions, type PriceList } from "~/lib/api-query-options/price-lists";

export function PriceListPrices({ list, canEdit, onEdit }: { list: PriceList; canEdit: boolean; onEdit: () => void }) {
  const t = useMessages(priceListMessages);
  const { fmt } = useCurrency();
  const [page, setPage] = useState(1);
  const [typed, setTyped] = useState("");
  const search = useDebounce(typed.trim(), 300);
  // A save of the prices invalidates every page of the list.
  const prices = useQuery(priceListPricesQueryOptions(list.id, page, search));
  const items = prices.data?.items ?? [];
  const pages = Math.max(1, Math.ceil((prices.data?.total ?? 0) / PRICE_LIST_PAGE_SIZE));

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 basis-60 space-y-1">
          <CardTitle>{t("pricesTitle")}</CardTitle>
          <CardDescription>{t("pricesDescription", { currency: list.currencyCode })}</CardDescription>
        </div>
        {canEdit ? <Button type="button" variant="outline" size="sm" onClick={onEdit}>{t("editPrices")}</Button> : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {list.variantCount > PRICE_LIST_PAGE_SIZE || search ? (
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
        ) : null}
        {prices.isError ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-body">{t("loadPricesFailed")}</p>
            <Button variant="outline" size="sm" onClick={() => void prices.refetch()}>{t("retry")}</Button>
          </div>
        ) : prices.isPending ? (
          <div className="space-y-2">{[0, 1, 2].map((index) => <Skeleton key={index} className="h-10 w-full" />)}</div>
        ) : items.length === 0 ? (
          <p className="text-body text-muted-foreground">{search ? t("noMatch") : t("noPrices")}</p>
        ) : (
          <div className="min-w-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead data-pin="primary">{t("columnProduct")}</TableHead>
                  <TableHead data-numeric="">{t("basePrice")}</TableHead>
                  <TableHead data-numeric="">{t("price")}</TableHead>
                  <TableHead>{t("quantityBreaks")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((variant) => {
                  const unit = variant.prices.find((price) => price.minQuantity === 1);
                  const breaks = variant.prices.filter((price) => price.minQuantity > 1);
                  return (
                    <TableRow key={variant.variantId}>
                      <TableCell data-pin="primary">
                        <span className="line-clamp-2 break-words font-medium">{variant.productName}</span>
                        <span className="block text-muted-foreground">
                          {variant.variantLabel ? `${variant.variantLabel} · ` : ""}{variant.sku}
                        </span>
                      </TableCell>
                      <TableCell data-numeric=""><span className="text-muted-foreground">{fmt(variant.basePrice)}</span></TableCell>
                      <TableCell data-numeric="">
                        {unit ? fmt(unit.amount) : t("noBreaks")}
                        {unit?.compareAt ? <s className="block text-muted-foreground">{fmt(unit.compareAt)}</s> : null}
                      </TableCell>
                      <TableCell>
                        {breaks.length === 0 ? (
                          <span className="text-muted-foreground">{t("noBreaks")}</span>
                        ) : (
                          <ul>
                            {breaks.map((price) => (
                              <li key={price.minQuantity}>{t("fromUnits", { count: price.minQuantity, price: fmt(price.amount) })}</li>
                            ))}
                          </ul>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
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
      </CardContent>
    </Card>
  );
}
