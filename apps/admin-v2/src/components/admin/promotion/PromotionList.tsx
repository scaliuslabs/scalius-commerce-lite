import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  CalendarClock,
  Gauge,
  Search,
  Sparkles,
  TicketPercent,
} from "lucide-react";

import { PromotionStatusBadge } from "./PromotionStatusBadge";
import {
  filterPromotions,
  minorToMajor,
  promotionUsageSummary,
} from "./promotion-editor-model";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import type { PromotionAggregate } from "~/lib/api-functions/promotions";

export type PromotionStatusFilter = "draft" | "active" | "paused" | "archived";

interface PromotionListProps {
  promotions: PromotionAggregate[];
  search: string;
  status?: PromotionStatusFilter;
  currencySymbol: string;
  canCreate: boolean;
  onSearchChange: (value: string) => void;
  onStatusChange: (value?: PromotionStatusFilter) => void;
}

const TARGET_LABEL: Record<string, string> = {
  line: "Items",
  order: "Order",
  shipping: "Delivery",
};

function effectSummary(
  promotion: PromotionAggregate,
  symbol: string,
): string {
  return promotion.effects.map((effect) => {
    const target = TARGET_LABEL[effect.target] ?? effect.target;
    if (effect.kind === "free") return `${target}: free`;
    if (effect.kind === "percentage_off") {
      const basisPoints = typeof effect.config.basisPoints === "number"
        ? effect.config.basisPoints
        : 0;
      return `${target}: ${basisPoints / 100}% off`;
    }
    const amountMinor = typeof effect.config.amountMinor === "number"
      ? effect.config.amountMinor
      : 0;
    const currency = typeof effect.config.currencyCode === "string"
      ? effect.config.currencyCode
      : promotion.budgetCurrencyCode ?? "BDT";
    return `${target}: ${symbol}${minorToMajor(amountMinor, currency)} off`;
  }).join(" · ");
}

function requirementSummary(promotion: PromotionAggregate, symbol: string): string {
  const parts = promotion.conditions.map((condition) => {
    if (condition.kind === "minimum_item_quantity") {
      const quantity = typeof condition.config.quantity === "number"
        ? condition.config.quantity
        : 0;
      return `${quantity} items`;
    }
    if (condition.kind === "minimum_merchandise_subtotal") {
      const amountMinor = typeof condition.config.amountMinor === "number"
        ? condition.config.amountMinor
        : 0;
      const currency = typeof condition.config.currencyCode === "string"
        ? condition.config.currencyCode
        : promotion.budgetCurrencyCode ?? "BDT";
      return `${symbol}${minorToMajor(amountMinor, currency)} subtotal`;
    }
    return "Saved condition";
  });
  return parts.length > 0 ? `Requires ${parts.join(" and ")}` : "No purchase minimum";
}

function formatSchedule(promotion: PromotionAggregate): string {
  const formatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeZone: promotion.timezone,
  });
  if (promotion.startsAtEpochSeconds === null && promotion.endsAtEpochSeconds === null) {
    return "No end date";
  }
  if (promotion.startsAtEpochSeconds !== null && promotion.endsAtEpochSeconds !== null) {
    return `${formatter.format(promotion.startsAtEpochSeconds * 1_000)}–${formatter.format(promotion.endsAtEpochSeconds * 1_000)}`;
  }
  if (promotion.startsAtEpochSeconds !== null) {
    return `Starts ${formatter.format(promotion.startsAtEpochSeconds * 1_000)}`;
  }
  return `Ends ${formatter.format((promotion.endsAtEpochSeconds ?? 0) * 1_000)}`;
}

function CodeStack({ promotion }: { promotion: PromotionAggregate }) {
  const active = promotion.codes.filter(({ isActive }) => isActive);
  const first = active[0] ?? promotion.codes[0];
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="max-w-52 truncate rounded-md bg-muted px-2 py-1 font-mono text-xs font-semibold">
        {first?.code ?? "No code"}
      </code>
      {promotion.codes.length > 1 ? (
        <span className="text-xs text-muted-foreground">+{promotion.codes.length - 1}</span>
      ) : null}
      {active.length === 0 ? (
        <span className="text-xs text-amber-700 dark:text-amber-300">all disabled</span>
      ) : null}
    </div>
  );
}

function PromotionUsage({
  promotion,
  currencySymbol,
}: {
  promotion: PromotionAggregate;
  currencySymbol: string;
}) {
  const usage = promotionUsageSummary(promotion, currencySymbol);
  return (
    <div className="flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground">
      <Gauge className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0">
        <p className="font-medium text-foreground/80">{usage.uses}</p>
        {usage.spend ? <p className="truncate">{usage.spend}</p> : null}
      </div>
    </div>
  );
}

function PromotionCard({
  promotion,
  currencySymbol,
}: {
  promotion: PromotionAggregate;
  currencySymbol: string;
}) {
  return (
    <article className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{promotion.name}</h2>
          {promotion.title ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{promotion.title}</p>
          ) : null}
        </div>
        <PromotionStatusBadge promotion={promotion} />
      </div>
      <div className="mt-3"><CodeStack promotion={promotion} /></div>
      <p className="mt-3 text-sm font-medium leading-5">
        {effectSummary(promotion, currencySymbol)}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {requirementSummary(promotion, currencySymbol)}
      </p>
      <div className="mt-3"><PromotionUsage promotion={promotion} currencySymbol={currencySymbol} /></div>
      <div className="mt-3 flex items-center justify-between gap-3 border-t pt-3 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          <CalendarClock className="size-3.5 shrink-0" />
          {formatSchedule(promotion)}
        </span>
        <Button asChild variant="ghost" size="sm" className="h-8 shrink-0 px-2">
          <Link to="/admin/promotions/$promotionId/edit" params={{ promotionId: promotion.id }}>
            Edit <ArrowRight className="ml-1 size-3.5" />
          </Link>
        </Button>
      </div>
    </article>
  );
}

export function PromotionList({
  promotions,
  search,
  status,
  currencySymbol,
  canCreate,
  onSearchChange,
  onStatusChange,
}: PromotionListProps) {
  const visible = filterPromotions(promotions, search, status);
  return (
    <section aria-label="Promotions" className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search promotions</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Find name or code…"
            className="h-9 pl-9"
          />
        </label>
        <Select
          value={status ?? "all"}
          onValueChange={(value) => onStatusChange(
            value === "all" ? undefined : value as PromotionStatusFilter,
          )}
        >
          <SelectTrigger className="h-9 w-full sm:w-40" aria-label="Filter promotions by status">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="paused">Paused</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {visible.length === 0 ? (
        <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed px-6 text-center">
          <span className="rounded-xl bg-muted p-3">
            {promotions.length === 0 ? (
              <Sparkles className="size-6 text-muted-foreground" />
            ) : (
              <TicketPercent className="size-6 text-muted-foreground" />
            )}
          </span>
          <h2 className="mt-3 text-sm font-semibold">
            {promotions.length === 0 ? "Create the first promotion" : "No matching promotions"}
          </h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            {promotions.length === 0
              ? "Start with a checkout code, then review the exact cart outcome before activation."
              : "Change the search or status filter to see other rules."}
          </p>
          {promotions.length === 0 && canCreate ? (
            <Button asChild size="sm" className="mt-4">
              <Link to="/admin/promotions/new">Create promotion</Link>
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:hidden">
            {visible.map((promotion) => (
              <PromotionCard
                key={promotion.id}
                promotion={promotion}
                currencySymbol={currencySymbol}
              />
            ))}
          </div>
          <div className="hidden overflow-hidden rounded-xl border bg-card sm:block">
            <table className="w-full table-fixed text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="w-[25%] px-4 py-2.5">Promotion</th>
                  <th className="w-[27%] px-4 py-2.5">Outcome</th>
                  <th className="w-[17%] px-4 py-2.5">Usage</th>
                  <th className="w-[17%] px-4 py-2.5">Schedule</th>
                  <th className="w-[10%] px-4 py-2.5">Status</th>
                  <th className="w-[4%] px-4 py-2.5"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {visible.map((promotion) => (
                  <tr key={promotion.id} className="group transition-colors hover:bg-muted/30">
                    <td className="px-4 py-3 align-top">
                      <Link
                        to="/admin/promotions/$promotionId/edit"
                        params={{ promotionId: promotion.id }}
                        className="font-semibold underline-offset-4 hover:underline"
                      >
                        {promotion.name}
                      </Link>
                      <div className="mt-1.5"><CodeStack promotion={promotion} /></div>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <p className="line-clamp-2 font-medium">{effectSummary(promotion, currencySymbol)}</p>
                      <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                        {requirementSummary(promotion, currencySymbol)}
                      </p>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <PromotionUsage promotion={promotion} currencySymbol={currencySymbol} />
                    </td>
                    <td className="px-4 py-3 align-top text-sm text-muted-foreground">
                      {formatSchedule(promotion)}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <PromotionStatusBadge promotion={promotion} />
                    </td>
                    <td className="px-4 py-3 text-right align-top">
                      <Button asChild variant="ghost" size="icon" className="size-8" aria-label={`Edit ${promotion.name}`}>
                        <Link to="/admin/promotions/$promotionId/edit" params={{ promotionId: promotion.id }}>
                          <ArrowRight className="size-4" />
                        </Link>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {visible.length} of {promotions.length} promotions
      </p>
    </section>
  );
}
