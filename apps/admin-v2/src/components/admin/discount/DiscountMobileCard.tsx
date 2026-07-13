import { formatDateShort } from "@scalius/shared/timestamps";
import { Check, Copy, Pencil, Tag, X } from "lucide-react";

import { DataTableRowActions } from "~/components/admin/data-table/DataTableRowActions";
import type { DiscountItem } from "~/components/admin/data-table/columns/discount-columns";
import { Checkbox } from "~/components/ui/checkbox";
import { Button } from "~/components/ui/button";
import { DiscountStatusBadge } from "./DiscountStatusBadge";
import {
  getDiscountLifecycle,
  getDiscountOutcome,
  getDiscountRequirement,
  getDiscountTypeLabel,
} from "./discount-list-model";

interface DiscountMobileCardProps {
  discount: DiscountItem;
  selected: boolean;
  showTrashed: boolean;
  symbol: string;
  canToggleStatus: boolean;
  onSelectedChange: (selected: boolean) => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onPermanentDelete: () => void;
  onToggleStatus: () => void;
}

export function DiscountMobileCard({
  discount,
  selected,
  showTrashed,
  symbol,
  canToggleStatus,
  onSelectedChange,
  onEdit,
  onDuplicate,
  onDelete,
  onRestore,
  onPermanentDelete,
  onToggleStatus,
}: DiscountMobileCardProps) {
  const status = getDiscountLifecycle(discount);
  const usage = discount.usageCount ?? 0;
  const usageLabel = discount.maxUses ? `${usage} / ${discount.maxUses}` : `${usage}`;

  return (
    <article className={selected ? "bg-primary/5 px-3 py-3" : "bg-background px-3 py-3"}>
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2.5">
        <Checkbox
          checked={selected}
          onCheckedChange={(value) => onSelectedChange(value === true)}
          aria-label={`Select ${discount.code}`}
          className="mt-1"
        />

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-mono text-sm font-semibold tracking-wide text-foreground">
              {discount.code}
            </span>
            <DiscountStatusBadge status={status} />
          </div>
          <p className="mt-1 text-sm font-medium leading-5 text-foreground">
            {getDiscountOutcome(discount, symbol)}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Tag className="h-3 w-3" aria-hidden="true" />
              {getDiscountTypeLabel(discount.type)}
            </span>
            <span>Code discount</span>
            <span>{getDiscountRequirement(discount, symbol)}</span>
          </div>
        </div>

        <DataTableRowActions
          showTrashed={showTrashed}
          menuLabel={`Open actions for ${discount.code}`}
          onEdit={!showTrashed ? onEdit : undefined}
          onDelete={!showTrashed ? onDelete : undefined}
          onRestore={showTrashed ? onRestore : undefined}
          onPermanentDelete={showTrashed ? onPermanentDelete : undefined}
          extraActions={
            !showTrashed
              ? [
                  { label: "Duplicate", icon: Copy, onClick: onDuplicate },
                  ...(canToggleStatus
                    ? [{
                        label: discount.isActive ? "Deactivate" : "Activate",
                        icon: discount.isActive ? X : Check,
                        onClick: onToggleStatus,
                      }]
                    : []),
                ]
              : undefined
          }
        />
      </div>

      <dl className="mt-3 grid grid-cols-3 divide-x rounded-md border bg-muted/20 py-2 text-center">
        <div className="min-w-0 px-2">
          <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Usage</dt>
          <dd className="mt-0.5 truncate text-xs font-semibold tabular-nums text-foreground">{usageLabel}</dd>
        </div>
        <div className="min-w-0 px-2">
          <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Starts</dt>
          <dd className="mt-0.5 truncate text-[11px] font-medium text-foreground" suppressHydrationWarning>
            {formatDateShort(discount.startDate)}
          </dd>
        </div>
        <div className="min-w-0 px-2">
          <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Ends</dt>
          <dd className="mt-0.5 truncate text-[11px] font-medium text-foreground" suppressHydrationWarning>
            {discount.endDate ? formatDateShort(discount.endDate) : "No end"}
          </dd>
        </div>
      </dl>

      {!showTrashed ? (
        <Button type="button" variant="outline" size="sm" className="mt-2.5 h-9" onClick={onEdit}>
          <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Edit discount
        </Button>
      ) : null}
    </article>
  );
}
