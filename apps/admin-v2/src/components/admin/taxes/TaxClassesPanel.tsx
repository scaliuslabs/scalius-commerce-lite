import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Layers3, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "~/components/admin/shell/EmptyState";
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
  deleteTaxClass,
  type TaxClassRecord,
  type TaxConfigurationPayload,
} from "~/lib/api-functions/taxes";
import { getServerFnError } from "~/lib/api-helpers";
import { queryKeys } from "~/lib/query-keys";

export function TaxClassesPanel({
  configuration,
  canManage,
  onCreateClass,
  onEditClass,
}: {
  configuration: TaxConfigurationPayload;
  canManage: boolean;
  onCreateClass: () => void;
  onEditClass: (taxClass: TaxClassRecord) => void;
}) {
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState<TaxClassRecord | null>(null);

  useEffect(() => {
    if (!deleting) return;
    const current = configuration.classes.find(
      (taxClass) => taxClass.id === deleting.id,
    );
    if (!current) setDeleting(null);
  }, [configuration.classes, deleting]);

  const ratesByClass = useMemo(() => {
    const counts = new Map<string, { total: number; active: number }>();
    for (const rate of configuration.rates) {
      const entry = counts.get(rate.taxClassId) ?? { total: 0, active: 0 };
      entry.total += 1;
      if (rate.isActive) entry.active += 1;
      counts.set(rate.taxClassId, entry);
    }
    return counts;
  }, [configuration.rates]);

  const defaultClassId = configuration.settings.defaultTaxClassId;
  const shippingClassId = configuration.settings.taxShipping
    ? configuration.settings.shippingTaxClassId ?? defaultClassId
    : null;

  const deleteMutation = useMutation({
    mutationFn: (taxClass: TaxClassRecord) => deleteTaxClass({ data: {
      id: taxClass.id,
      expectedVersion: taxClass.version,
    } }),
    onSuccess: async () => {
      toast.success("Tax class deleted");
      setDeleting(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings.taxes() });
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Tax class is still in use or changed in another tab."));
      setDeleting(null);
    },
  });

  const columns: IndexTableColumn<TaxClassRecord>[] = [
    {
      id: "name",
      header: "Class",
      mobileLabel: "Class",
      cell: (taxClass) => (
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-medium">{taxClass.name}</span>
            {taxClass.id === defaultClassId ? (
              <StatusBadge tone="info" dot={false} srLabel="Role:">
                Store default
              </StatusBadge>
            ) : null}
            {taxClass.id === shippingClassId && taxClass.id !== defaultClassId ? (
              <StatusBadge tone="info" dot={false} srLabel="Role:">
                Shipping
              </StatusBadge>
            ) : null}
          </span>
          <span className="line-clamp-2 text-xs text-muted-foreground">
            {taxClass.description || "No description"}
          </span>
        </span>
      ),
    },
    {
      id: "treatment",
      header: "Treatment",
      mobileLabel: "Treatment",
      cell: (taxClass) => (
        <StatusBadge tone={taxClass.isExempt ? "neutral" : "success"} srLabel="Treatment:">
          {taxClass.isExempt ? "Exempt" : "Taxable"}
        </StatusBadge>
      ),
    },
    {
      id: "rates",
      header: "Rates",
      mobileLabel: "Rates",
      align: "end",
      cell: (taxClass) => {
        const counts = ratesByClass.get(taxClass.id) ?? { total: 0, active: 0 };
        return (
          <span className="text-sm tabular-nums">
            {counts.active} active
            <span className="text-muted-foreground"> of {counts.total}</span>
          </span>
        );
      },
    },
  ];

  return (
    <div className="space-y-4">
      <IndexTable
        label="Tax classes"
        items={configuration.classes}
        columns={columns}
        getRowId={(taxClass) => taxClass.id}
        onRowClick={canManage ? onEditClass : undefined}
        empty={(
          <EmptyState
            icon={Layers3}
            heading="No tax classes yet"
            body="Create the class that unclassified products fall back to, then add its destination rates."
            action={{
              label: "Add tax class",
              onClick: onCreateClass,
              disabled: !canManage,
            }}
          />
        )}
        rowActions={(taxClass) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-11 w-11 sm:h-8 sm:w-8"
                aria-label={`Actions for ${taxClass.name}`}
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={!canManage} onSelect={() => onEditClass(taxClass)}>
                <Pencil className="h-4 w-4" aria-hidden="true" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                disabled={!canManage}
                onSelect={() => setDeleting(taxClass)}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        footer={(
          <p className="text-xs text-muted-foreground">
            A class cannot be deleted while settings, rates, products, or SKUs still
            reference it.
          </p>
        )}
      />

      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The class is soft-deleted only if no saved rate or catalog item still uses
              it. Existing order tax totals do not change.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => deleting && deleteMutation.mutate(deleting)}
              disabled={deleteMutation.isPending}
            >
              Delete class
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
