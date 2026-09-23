import { Link, useNavigate } from "@tanstack/react-router";
import { TicketPercent } from "lucide-react";
import { useState } from "react";

import { DiscountStatusBadge } from "./DiscountStatusBadge";
import { DiscountTypeDialog } from "./DiscountTypeDialog";
import { discountStatus, discountTypeOf, type DiscountStatus } from "./discount-form";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { formatDateTime, formatNumber, useMessages } from "~/i18n";
import { discountsMessages, type DiscountMessageKey } from "~/i18n/discounts";
import type { DiscountRecord } from "~/lib/api-query-options/discounts";

export const DISCOUNT_TABS = ["all", "active", "scheduled", "expired"] as const;
export type DiscountTab = (typeof DISCOUNT_TABS)[number];

const TAB_LABEL = { all: "tabAll", active: "tabActive", scheduled: "tabScheduled", expired: "tabExpired" } as const;

export function filterDiscounts(
  discounts: DiscountRecord[],
  tab: DiscountTab,
  query: string,
  now = Math.floor(Date.now() / 1_000),
): DiscountRecord[] {
  const needle = query.trim().toLowerCase();
  return discounts.filter((discount) => {
    const status: DiscountStatus = discountStatus(discount, now);
    if (tab !== "all" && status !== tab) return false;
    return !needle || [discount.name, ...discount.codes.map(({ code }) => code)]
      .some((value) => value.toLowerCase().includes(needle));
  });
}

function datesLabel(discount: DiscountRecord, t: (key: DiscountMessageKey, vars?: Record<string, string | number>) => string) {
  const date = (epoch: number) => formatDateTime(new Date(epoch * 1_000), { dateStyle: "medium" });
  if (discount.startsAtEpochSeconds === null) return "—";
  return discount.endsAtEpochSeconds === null
    ? t("datesFrom", { start: date(discount.startsAtEpochSeconds) })
    : t("datesBetween", { start: date(discount.startsAtEpochSeconds), end: date(discount.endsAtEpochSeconds) });
}

/** Shopify's Discounts index: one list of code and automatic discounts. */
export function DiscountList({
  discounts,
  tab,
  query,
  canCreate,
  onTabChange,
  onQueryChange,
}: {
  discounts: DiscountRecord[];
  tab: DiscountTab;
  query: string;
  canCreate: boolean;
  onTabChange: (tab: DiscountTab) => void;
  onQueryChange: (query: string) => void;
}) {
  const t = useMessages(discountsMessages);
  const navigate = useNavigate();
  const [chooserOpen, setChooserOpen] = useState(false);
  const visible = filterDiscounts(discounts, tab, query);
  const title = (discount: DiscountRecord) => discount.codes[0]?.code ?? discount.name;
  const open = (discount: DiscountRecord) =>
    void navigate({ to: "/admin/discounts/$discountId", params: { discountId: discount.id } });

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-heading-lg">{t("pageTitle")}</h1>
        {canCreate && discounts.length > 0 ? (
          <Button type="button" onClick={() => setChooserOpen(true)}>{t("createDiscount")}</Button>
        ) : null}
      </header>

      {discounts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <TicketPercent aria-hidden className="size-10 text-muted-foreground" />
            <h2 className="text-heading-md">{t("emptyTitle")}</h2>
            <p className="max-w-sm text-body text-muted-foreground">{t("emptyBody")}</p>
            {canCreate ? (
              <Button type="button" onClick={() => setChooserOpen(true)}>{t("createDiscount")}</Button>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <div className="flex flex-col gap-3 border-b p-3 sm:flex-row sm:items-center sm:justify-between">
            <Tabs value={tab} onValueChange={(value) => onTabChange(value as DiscountTab)} className="max-w-full overflow-x-auto">
              <TabsList>
                {DISCOUNT_TABS.map((item) => (
                  <TabsTrigger key={item} value={item}>{t(TAB_LABEL[item])}</TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <div className="sm:w-64">
              <Input
                type="search"
                value={query}
                placeholder={t("searchPlaceholder")}
                aria-label={t("searchPlaceholder")}
                onChange={(event) => onQueryChange(event.target.value)}
              />
            </div>
          </div>
          {visible.length === 0 ? (
            <p className="p-6 text-center text-body text-muted-foreground">{t("noMatches")}</p>
          ) : (
            <>
              <ul className="divide-y sm:hidden">
                {visible.map((discount) => (
                  <li key={discount.id}>
                    <Link
                      to="/admin/discounts/$discountId"
                      params={{ discountId: discount.id }}
                      className="flex min-h-14 items-start justify-between gap-3 p-3 hover:bg-muted"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-body font-medium">{title(discount)}</span>
                        <span className="block text-body text-muted-foreground">
                          {t(`type_${discountTypeOf(discount)}`)} · {t("usedCount", { count: formatNumber(discount.redemptionCount) })}
                        </span>
                      </span>
                      <DiscountStatusBadge discount={discount} />
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="hidden sm:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("columnTitle")}</TableHead>
                      <TableHead>{t("columnStatus")}</TableHead>
                      <TableHead>{t("columnMethod")}</TableHead>
                      <TableHead>{t("columnType")}</TableHead>
                      <TableHead>{t("columnUsed")}</TableHead>
                      <TableHead>{t("columnDates")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((discount) => (
                      <TableRow key={discount.id} onClick={() => open(discount)}>
                        <TableCell>
                          <Link
                            to="/admin/discounts/$discountId"
                            params={{ discountId: discount.id }}
                            className="font-medium hover:underline"
                            onClick={(event) => event.stopPropagation()}
                          >
                            {title(discount)}
                          </Link>
                        </TableCell>
                        <TableCell><DiscountStatusBadge discount={discount} /></TableCell>
                        <TableCell>{t(discount.method === "code" ? "methodCode" : "methodAutomatic")}</TableCell>
                        <TableCell>{t(`type_${discountTypeOf(discount)}`)}</TableCell>
                        <TableCell>{formatNumber(discount.redemptionCount)}</TableCell>
                        <TableCell>{datesLabel(discount, t)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </Card>
      )}
      <DiscountTypeDialog open={chooserOpen} onOpenChange={setChooserOpen} />
    </div>
  );
}
