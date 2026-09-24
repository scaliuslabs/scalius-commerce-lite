import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpDown, TicketPercent } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { DiscountStatusBadge } from "./DiscountStatusBadge";
import { DiscountTypeDialog } from "./DiscountTypeDialog";
import { describeValue, discountStatus, discountTypeOf, draftFromDiscount, type DiscountStatus, type SummaryFormat } from "./discount-form";
import { useScopeLabel } from "./ScopeField";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { usePermissions } from "~/contexts/PermissionContext";
import { useCurrency } from "~/hooks/use-currency";
import { formatDateTime, formatNumber, useMessages } from "~/i18n";
import { discountsMessages, type DiscountMessageKey } from "~/i18n/discounts";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { useDeleteDiscount, useSetDiscountActive } from "~/lib/api-mutations/discounts";
import type { DiscountRecord } from "~/lib/api-query-options/discounts";

export const DISCOUNT_TABS = ["all", "active", "scheduled", "expired"] as const;
export type DiscountTab = (typeof DISCOUNT_TABS)[number];

const TAB_LABEL = { all: "tabAll", active: "tabActive", scheduled: "tabScheduled", expired: "tabExpired" } as const;

export const DISCOUNT_SORTS = ["updated", "titleAsc", "titleDesc", "used"] as const;
export type DiscountSort = (typeof DISCOUNT_SORTS)[number];
const SORT_LABEL = { updated: "sortUpdated", titleAsc: "sortTitleAsc", titleDesc: "sortTitleDesc", used: "sortUsed" } as const;

/** Discount codes never go into the URL; the search survives only this tab's session. */
const SEARCH_KEY = "admin.listSearch.discounts";

const titleOf = (discount: DiscountRecord) => discount.codes[0]?.code ?? discount.name;

export function filterDiscounts(
  discounts: DiscountRecord[],
  tab: DiscountTab,
  query: string,
  sort: DiscountSort = "updated",
  now = Math.floor(Date.now() / 1_000),
): DiscountRecord[] {
  const needle = query.trim().toLowerCase();
  const rows = discounts.filter((discount) => {
    const status: DiscountStatus = discountStatus(discount, now);
    if (tab !== "all" && status !== tab) return false;
    return !needle || [discount.name, ...discount.codes.map(({ code }) => code)]
      .some((value) => value.toLowerCase().includes(needle));
  });
  // The API already lists the newest edits first.
  if (sort === "used") return rows.sort((left, right) => right.redemptionCount - left.redemptionCount);
  if (sort === "titleAsc") return rows.sort((left, right) => titleOf(left).localeCompare(titleOf(right)));
  if (sort === "titleDesc") return rows.sort((left, right) => titleOf(right).localeCompare(titleOf(left)));
  return rows;
}

function datesLabel(discount: DiscountRecord, t: (key: DiscountMessageKey, vars?: Record<string, string | number>) => string) {
  const date = (epoch: number) => formatDateTime(new Date(epoch * 1_000), { dateStyle: "medium" });
  if (discount.startsAtEpochSeconds === null) return "—";
  return discount.endsAtEpochSeconds === null
    ? t("datesFrom", { start: date(discount.startsAtEpochSeconds) })
    : t("datesBetween", { start: date(discount.startsAtEpochSeconds), end: date(discount.endsAtEpochSeconds) });
}

type BulkAction = "activate" | "deactivate" | "delete";

/** Shopify's Discounts index: one list of code and automatic discounts. */
export function DiscountList({
  discounts,
  tab,
  onTabChange,
}: {
  discounts: DiscountRecord[];
  tab: DiscountTab;
  onTabChange: (tab: DiscountTab) => void;
}) {
  const t = useMessages(discountsMessages);
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  const { code: currencyCode, fmt } = useCurrency();
  const scopeLabel = useScopeLabel();
  const [chooserOpen, setChooserOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<DiscountSort>("updated");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirmRows, setConfirmRows] = useState<DiscountRecord[] | null>(null);
  const [bulkBusy, setBulkBusy] = useState<BulkAction | null>(null);
  const activeMutation = useSetDiscountActive();
  const deleteMutation = useDeleteDiscount();
  const canCreate = hasPermission(ADMIN_PERMISSIONS.DISCOUNTS_CREATE);
  const canToggle = hasPermission(ADMIN_PERMISSIONS.DISCOUNTS_TOGGLE_STATUS);
  const canDelete = hasPermission(ADMIN_PERMISSIONS.DISCOUNTS_DELETE);

  useEffect(() => {
    try {
      setQuery(sessionStorage.getItem(SEARCH_KEY) ?? "");
    } catch {
      // Storage blocked: the search just isn't remembered.
    }
  }, []);
  function search(value: string) {
    setQuery(value);
    try {
      if (value) sessionStorage.setItem(SEARCH_KEY, value);
      else sessionStorage.removeItem(SEARCH_KEY);
    } catch {
      // Storage blocked: the search just isn't remembered.
    }
  }

  const visible = filterDiscounts(discounts, tab, query, sort);
  const chosen = visible.filter((discount) => selected.has(discount.id));
  const toActivate = chosen.filter((discount) => discount.status !== "active" && discount.status !== "archived");
  const toDeactivate = chosen.filter((discount) => discount.status === "active");
  const allChosen = visible.length > 0 && chosen.length === visible.length;
  const canSelect = canToggle || canDelete;
  const format: SummaryFormat = {
    money: (major) => fmt(Number(major)),
    number: (value) => formatNumber(Number(value)),
    date: () => "",
    scope: (scope) => scopeLabel(scope, new Map()),
  };
  const valueOf = (discount: DiscountRecord) => {
    const { key, vars } = describeValue(draftFromDiscount(discount, currencyCode), currencyCode, format);
    return t(key, vars);
  };
  const open = (discount: DiscountRecord) =>
    void navigate({ to: "/admin/discounts/$discountId", params: { discountId: discount.id } });
  const toggle = (id: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /** One request per discount, each with its own revision; failures toast their reason. */
  async function runBulk(action: BulkAction, rows: DiscountRecord[]) {
    setBulkBusy(action);
    let done = 0;
    for (const discount of rows) {
      try {
        if (action === "delete") {
          await deleteMutation.mutateAsync({ id: discount.id, expectedRevision: discount.revision });
        } else {
          await activeMutation.mutateAsync({ id: discount.id, expectedRevision: discount.revision, active: action === "activate" });
        }
        done += 1;
      } catch {
        // The mutation already said why; carry on with the rest.
      }
    }
    setBulkBusy(null);
    setConfirmRows(null);
    setSelected(new Set());
    if (done === 1) {
      toast.success(t(action === "delete" ? "toastDeleted" : action === "activate" ? "toastActivated" : "toastDeactivated"));
    } else if (done > 1) {
      const key = action === "delete" ? "bulkDeleted" : action === "activate" ? "bulkActivated" : "bulkDeactivated";
      toast.success(t(key, { count: formatNumber(done) }));
    }
  }

  const rowCheckbox = (discount: DiscountRecord) => (
    <Checkbox
      checked={selected.has(discount.id)}
      disabled={bulkBusy !== null}
      aria-label={t("selectRow", { name: titleOf(discount) })}
      onCheckedChange={(value) => toggle(discount.id, value === true)}
    />
  );

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
            <div className="flex gap-2">
              <Input
                type="search"
                value={query}
                className="sm:w-64"
                placeholder={t("searchPlaceholder")}
                aria-label={t("searchPlaceholder")}
                onChange={(event) => search(event.target.value)}
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="icon" aria-label={t("sort")}>
                    <ArrowUpDown aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuRadioGroup value={sort} onValueChange={(value) => setSort(value as DiscountSort)}>
                    {DISCOUNT_SORTS.map((item) => (
                      <DropdownMenuRadioItem key={item} value={item}>{t(SORT_LABEL[item])}</DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          {chosen.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
              <span className="mr-auto text-body">{t("selectedCount", { count: formatNumber(chosen.length) })}</span>
              {canToggle && toActivate.length > 0 ? (
                <Button type="button" variant="outline" size="sm" disabled={bulkBusy !== null} loading={bulkBusy === "activate"} onClick={() => void runBulk("activate", toActivate)}>
                  {t("activate")}
                </Button>
              ) : null}
              {canToggle && toDeactivate.length > 0 ? (
                <Button type="button" variant="outline" size="sm" disabled={bulkBusy !== null} loading={bulkBusy === "deactivate"} onClick={() => void runBulk("deactivate", toDeactivate)}>
                  {t("deactivate")}
                </Button>
              ) : null}
              {canDelete ? (
                <Button type="button" variant="destructive" size="sm" disabled={bulkBusy !== null} onClick={() => setConfirmRows(chosen)}>
                  {t(chosen.length === 1 ? "delete" : "bulkDelete")}
                </Button>
              ) : null}
            </div>
          ) : null}
          {visible.length === 0 ? (
            <div className="flex flex-col items-center gap-1 px-6 py-10 text-center">
              <h2 className="text-heading-md">{t("noMatches")}</h2>
              <p className="text-body text-muted-foreground">{t("noMatchesHint")}</p>
              {query ? (
                <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => search("")}>
                  {t("clearSearch")}
                </Button>
              ) : null}
            </div>
          ) : (
            <>
              <ul className="divide-y sm:hidden">
                {visible.map((discount) => (
                  <li key={discount.id} className="flex items-start gap-3 px-3 hover:bg-muted">
                    {canSelect ? <span className="flex h-11 items-center">{rowCheckbox(discount)}</span> : null}
                    <Link
                      to="/admin/discounts/$discountId"
                      params={{ discountId: discount.id }}
                      className="flex min-h-14 min-w-0 flex-1 items-start justify-between gap-3 py-3"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-body font-medium">{titleOf(discount)}</span>
                        <span className="block text-body text-muted-foreground">
                          {valueOf(discount)} · {t("usedCount", { count: formatNumber(discount.redemptionCount) })}
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
                      {canSelect ? (
                        <TableHead>
                          <Checkbox
                            checked={allChosen ? true : chosen.length > 0 ? "indeterminate" : false}
                            disabled={bulkBusy !== null}
                            aria-label={t("selectAll")}
                            onCheckedChange={() => setSelected(allChosen ? new Set() : new Set(visible.map(({ id }) => id)))}
                          />
                        </TableHead>
                      ) : null}
                      <TableHead>{t("columnTitle")}</TableHead>
                      <TableHead>{t("columnStatus")}</TableHead>
                      <TableHead>{t("columnMethod")}</TableHead>
                      <TableHead>{t("columnType")}</TableHead>
                      <TableHead className="text-right">{t("columnUsed")}</TableHead>
                      <TableHead>{t("columnDates")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((discount) => (
                      <TableRow
                        key={discount.id}
                        data-state={selected.has(discount.id) ? "selected" : undefined}
                        className="cursor-pointer"
                        onClick={() => open(discount)}
                      >
                        {canSelect ? (
                          <TableCell onClick={(event) => event.stopPropagation()}>{rowCheckbox(discount)}</TableCell>
                        ) : null}
                        <TableCell>
                          <Link
                            to="/admin/discounts/$discountId"
                            params={{ discountId: discount.id }}
                            className="font-medium hover:underline"
                            onClick={(event) => event.stopPropagation()}
                          >
                            {titleOf(discount)}
                          </Link>
                          <span className="block text-muted-foreground">{valueOf(discount)}</span>
                        </TableCell>
                        <TableCell><DiscountStatusBadge discount={discount} /></TableCell>
                        <TableCell>{t(discount.method === "code" ? "methodCode" : "methodAutomatic")}</TableCell>
                        <TableCell>{t(`type_${discountTypeOf(discount)}`)}</TableCell>
                        <TableCell className="text-right">
                          {formatNumber(discount.redemptionCount)}
                          {discount.maxRedemptions !== null ? ` / ${formatNumber(discount.maxRedemptions)}` : null}
                        </TableCell>
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
      <ConfirmDialog
        open={confirmRows !== null}
        onOpenChange={(next) => {
          if (!next && !bulkBusy) setConfirmRows(null);
        }}
        title={confirmRows?.length === 1
          ? t("deleteTitle", { name: titleOf(confirmRows[0]!) })
          : t("bulkDeleteTitle", { count: formatNumber(confirmRows?.length ?? 0) })}
        description={t(confirmRows?.length === 1 ? "deleteBody" : "bulkDeleteBody")}
        confirmLabel={t(confirmRows?.length === 1 ? "delete" : "bulkDelete")}
        cancelLabel={t("cancel")}
        isLoading={bulkBusy === "delete"}
        onConfirm={() => void runBulk("delete", confirmRows ?? [])}
      />
    </div>
  );
}
