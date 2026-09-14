import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MapPinned, MoreHorizontal, Pencil, Power, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "~/components/admin/shell/EmptyState";
import { IndexFilters } from "~/components/admin/shell/IndexFilters";
import { IndexTable, type IndexTableColumn } from "~/components/admin/shell/IndexTable";
import { StatusBadge } from "~/components/admin/shell/StatusBadge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  deleteTaxRate,
  updateTaxRate,
  type TaxConfigurationPayload,
  type TaxRateRecord,
} from "~/lib/api-functions/taxes";
import { getServerFnError } from "~/lib/api-helpers";
import { queryKeys } from "~/lib/query-keys";
import { basisPointsToPercent } from "./tax-form";
import { TaxRateDiagnosticsPanel } from "./TaxRateDiagnosticsPanel";
import { getRequiredTaxRateRoles } from "./tax-readiness";

type RateStatusFilter = "all" | "active" | "inactive";

const STATUS_FILTERS: readonly { id: RateStatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "inactive", label: "Inactive" },
];

export function rateDestinationLabel(rate: TaxRateRecord): string {
  if (rate.jurisdictionType === "all") return "All destinations";
  return rate.jurisdictionLabel ?? rate.jurisdictionType;
}

/** Local list filtering. Rates are a small merchant-authored set, so this stays client-side. */
export function filterTaxRates(
  rates: readonly TaxRateRecord[],
  options: {
    status: RateStatusFilter;
    search: string;
    className: (taxClassId: string) => string;
  },
): TaxRateRecord[] {
  const needle = options.search.trim().toLowerCase();
  return rates.filter((rate) => {
    if (options.status === "active" && !rate.isActive) return false;
    if (options.status === "inactive" && rate.isActive) return false;
    if (!needle) return true;
    return [
      rate.name,
      rateDestinationLabel(rate),
      options.className(rate.taxClassId),
    ].some((value) => value.toLowerCase().includes(needle));
  });
}

export function TaxRatesPanel({
  configuration,
  canManage,
  onCreateRate,
  onEditRate,
  onOpenClasses,
  onOpenPreview,
}: {
  configuration: TaxConfigurationPayload;
  canManage: boolean;
  /** Opens the rate editor, optionally pre-selecting a class with a coverage gap. */
  onCreateRate: (taxClassId?: string) => void;
  onEditRate: (rate: TaxRateRecord) => void;
  onOpenClasses: () => void;
  onOpenPreview: () => void;
}) {
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState<TaxRateRecord | null>(null);
  const [deactivating, setDeactivating] = useState<TaxRateRecord | null>(null);
  const [status, setStatus] = useState<RateStatusFilter>("all");
  const [search, setSearch] = useState("");

  const className = useMemo(() => {
    const names = new Map(configuration.classes.map((taxClass) => [taxClass.id, taxClass.name]));
    return (taxClassId: string) => names.get(taxClassId) ?? "Unknown class";
  }, [configuration.classes]);

  const rows = useMemo(
    () => filterTaxRates(configuration.rates, { status, search, className }),
    [className, configuration.rates, search, status],
  );

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.settings.taxes() });
  };
  const deleteMutation = useMutation({
    mutationFn: (rate: TaxRateRecord) => deleteTaxRate({ data: {
      id: rate.id,
      expectedVersion: rate.version,
    } }),
    onSuccess: async () => {
      toast.success("Tax rate deleted");
      setDeleting(null);
      await refresh();
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Tax rate changed in another tab."));
      setDeleting(null);
    },
  });
  const activationMutation = useMutation({
    mutationFn: (input: { rate: TaxRateRecord; isActive: boolean }) => updateTaxRate({ data: {
      id: input.rate.id,
      expectedVersion: input.rate.version,
      update: {
        taxClassId: input.rate.taxClassId,
        name: input.rate.name,
        rateBps: input.rate.rateBps,
        jurisdictionType: input.rate.jurisdictionType,
        jurisdictionId: input.rate.jurisdictionId,
        jurisdictionLabel: input.rate.jurisdictionLabel,
        priority: input.rate.priority,
        isCompound: input.rate.isCompound,
        isActive: input.isActive,
      },
    } }),
    onSuccess: async (_result, input) => {
      toast.success(input.isActive ? "Tax rate activated" : "Tax rate deactivated");
      setDeactivating(null);
      await refresh();
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Tax rate changed in another tab."));
      setDeactivating(null);
    },
  });

  const deletingRequiredRoles = getRequiredTaxRateRoles(configuration, deleting);
  const deactivatingRequiredRoles = getRequiredTaxRateRoles(configuration, deactivating);

  const columns: IndexTableColumn<TaxRateRecord>[] = [
    {
      id: "destination",
      header: "Destination",
      mobileLabel: "Destination",
      cell: (rate) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{rateDestinationLabel(rate)}</span>
          <span className="truncate text-xs text-muted-foreground">{rate.name}</span>
        </span>
      ),
    },
    {
      id: "class",
      header: "Class",
      mobileLabel: "Class",
      cell: (rate) => (
        <span className="truncate text-sm">{className(rate.taxClassId)}</span>
      ),
    },
    {
      id: "rate",
      header: "Rate",
      mobileLabel: "Rate",
      align: "end",
      cell: (rate) => (
        <span className="flex flex-col items-end">
          <span className="font-medium tabular-nums">
            {basisPointsToPercent(rate.rateBps)}%
          </span>
          <span className="text-xs text-muted-foreground">
            Priority {rate.priority}{rate.isCompound ? " · compound" : ""}
          </span>
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      mobileLabel: "Status",
      cell: (rate) => (
        <StatusBadge tone={rate.isActive ? "success" : "neutral"} srLabel="Status:">
          {rate.isActive ? "Active" : "Inactive"}
        </StatusBadge>
      ),
    },
  ];

  const hasRates = configuration.rates.length > 0;

  return (
    <div className="space-y-6">
      <TaxRateDiagnosticsPanel
        configuration={configuration}
        canManage={canManage}
        onAddBroadRate={(taxClassId) => onCreateRate(taxClassId)}
        onOpenClasses={onOpenClasses}
        onReviewRate={(rateId) => {
          const rate = configuration.rates.find((candidate) => candidate.id === rateId);
          if (rate) onEditRate(rate);
        }}
        onOpenPreview={onOpenPreview}
      />

      <div className="space-y-3">
        {hasRates ? (
          <IndexFilters
            label="Filter tax rates"
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search rate, destination, or class"
            filters={STATUS_FILTERS.map((filter) => ({
              id: filter.id,
              label: filter.label,
              count: filterTaxRates(configuration.rates, {
                status: filter.id,
                search,
                className,
              }).length,
            }))}
            activeFilterId={status}
            onFilterChange={(id) => setStatus(id as RateStatusFilter)}
          />
        ) : null}

        <IndexTable
          label="Tax rates"
          items={rows}
          columns={columns}
          getRowId={(rate) => rate.id}
          onRowClick={canManage ? onEditRate : undefined}
          empty={hasRates ? (
            <EmptyState
              icon={MapPinned}
              heading="No rates match this filter"
              body="Clear the search or choose another status to see the saved rates."
              action={{
                label: "Clear filters",
                variant: "outline",
                onClick: () => {
                  setSearch("");
                  setStatus("all");
                },
              }}
            />
          ) : (
            <EmptyState
              icon={MapPinned}
              heading="No tax rates yet"
              body="Add the rate each taxable class charges, starting with an all-destination rate so no checkout is left untaxed."
              action={{
                label: "Add tax rate",
                onClick: () => onCreateRate(),
                disabled: !canManage || configuration.classes.length === 0,
              }}
              secondaryAction={configuration.classes.length === 0 ? {
                label: "Add a tax class first",
                onClick: onOpenClasses,
              } : undefined}
            />
          )}
          rowActions={(rate) => (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-11 w-11 sm:h-8 sm:w-8"
                  aria-label={`Actions for ${rate.name}`}
                >
                  <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={!canManage} onSelect={() => onEditRate(rate)}>
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!canManage || activationMutation.isPending}
                  onSelect={() => {
                    if (rate.isActive) {
                      setDeactivating(rate);
                      return;
                    }
                    activationMutation.mutate({ rate, isActive: true });
                  }}
                >
                  <Power className="h-4 w-4" aria-hidden="true" />
                  {rate.isActive ? "Deactivate" : "Activate"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  disabled={!canManage}
                  onSelect={() => setDeleting(rate)}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          footer={(
            <p className="text-xs text-muted-foreground">
              {configuration.rates.length} saved{" "}
              {configuration.rates.length === 1 ? "rate" : "rates"}. Every rate that
              matches a checkout is added together.
            </p>
          )}
        />
      </div>

      <AlertDialog
        open={Boolean(deactivating)}
        onOpenChange={(open) => !open && setDeactivating(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate {deactivating?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deactivatingRequiredRoles.length > 0
                ? `This is the only active rate for ${deactivatingRequiredRoles.join(" and ")}. Add a replacement before deactivating it while tax calculation is enabled.`
                : "The rate stops matching new checkouts immediately. Existing order tax totals do not change."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={activationMutation.isPending || deactivatingRequiredRoles.length > 0}
              onClick={() => deactivating
                && deactivatingRequiredRoles.length === 0
                && activationMutation.mutate({ rate: deactivating, isActive: false })}
            >
              Deactivate rate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingRequiredRoles.length > 0
                ? `This is the only active rate for ${deletingRequiredRoles.join(" and ")}. Add a replacement before deleting it while tax calculation is enabled.`
                : "The rule will stop participating in future quotes. Existing order tax snapshots do not change."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteMutation.isPending || deletingRequiredRoles.length > 0}
              onClick={() => deleting && deletingRequiredRoles.length === 0 && deleteMutation.mutate(deleting)}
            >
              Delete rate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
