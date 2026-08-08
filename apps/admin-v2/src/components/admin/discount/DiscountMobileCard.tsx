import { AlertTriangle, Check, Copy, Pencil, Tag, X } from "lucide-react";

import { DataTableRowActions } from "~/components/admin/data-table/DataTableRowActions";
import type { DiscountItem } from "~/components/admin/data-table/columns/discount-columns";
import { Checkbox } from "~/components/ui/checkbox";
import { Button } from "~/components/ui/button";
import { formatAdminDate } from "~/lib/admin-time";
import { DiscountStatusBadge } from "./DiscountStatusBadge";
import {
  getDiscountLifecycle,
  getDiscountOutcome,
  getDiscountReadinessIssues,
  getDiscountRequirement,
  getDiscountTypeLabel,
} from "./discount-list-model";

interface DiscountMobileCardProps {
  discount: DiscountItem;
  selected: boolean;
  showTrashed: boolean;
  symbol: string;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canRestore: boolean;
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
  canCreate,
  canEdit,
  canDelete,
  canRestore,
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
  const readinessIssues = getDiscountReadinessIssues(discount);
  const hasRowActions = showTrashed
    ? canRestore || canDelete
    : canEdit || canCreate || canDelete || canToggleStatus;

  return (
    <article className={selected ? "bg-primary/5 px-3 py-3" : "bg-background px-3 py-3"}>
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2.5">
        <Checkbox
          checked={selected}
          onCheckedChange={(value) => onSelectedChange(value === true)}
          aria-label={`Select ${discount.code}`}
          disabled={!canDelete}
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

        {hasRowActions ? (
          <DataTableRowActions
            showTrashed={showTrashed}
            menuLabel={`Open actions for ${discount.code}`}
            onEdit={!showTrashed && canEdit ? onEdit : undefined}
            onDelete={!showTrashed && canDelete ? onDelete : undefined}
            onRestore={showTrashed && canRestore ? onRestore : undefined}
            onPermanentDelete={showTrashed && canDelete ? onPermanentDelete : undefined}
            extraActions={
              !showTrashed
                ? [
                    ...(canCreate
                      ? [{ label: "Duplicate", icon: Copy, onClick: onDuplicate }]
                      : []),
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
        ) : null}
      </div>

      {readinessIssues.length > 0 ? (
        <div className="mt-2.5 flex gap-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <div className="min-w-0 text-xs leading-4">
            <p className="font-semibold">Rule needs review</p>
            <ul className="mt-0.5 space-y-0.5">
              {readinessIssues.map((issue) => (
                <li key={issue.code}>{issue.message}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <dl className="mt-3 grid grid-cols-3 divide-x rounded-md border bg-muted/20 py-2 text-center">
        <div className="min-w-0 px-2">
          <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Usage</dt>
          <dd className="mt-0.5 truncate text-xs font-semibold tabular-nums text-foreground">{usageLabel}</dd>
        </div>
        <div className="min-w-0 px-2">
          <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Starts</dt>
          <dd className="mt-0.5 truncate text-[11px] font-medium text-foreground">
            {formatAdminDate(discount.startDate) ?? "N/A"}
          </dd>
        </div>
        <div className="min-w-0 px-2">
          <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Ends</dt>
          <dd className="mt-0.5 truncate text-[11px] font-medium text-foreground">
            {discount.endDate ? formatAdminDate(discount.endDate) ?? "N/A" : "No end"}
          </dd>
        </div>
      </dl>

      {!showTrashed && canEdit ? (
        <Button type="button" variant="outline" size="sm" className="mt-2.5 h-11 sm:h-9" onClick={onEdit}>
          <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Edit discount
        </Button>
      ) : null}
    </article>
  );
}
