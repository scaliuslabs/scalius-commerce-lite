import { useState } from "react";
import { toast } from "~/lib/toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import type { InventoryVariant } from "~/lib/api-query-options/inventory";
import {
  costProblem,
  isSkuCostConflict,
  sameCost,
  saveSkuCosts,
  SKU_COST_BATCH_LIMIT,
  type SkuCostItem,
} from "~/lib/api-query-options/inventory-costs";
import { useMessages } from "~/i18n";
import { inventoryMessages } from "~/i18n/inventory";
import { resourceMessages } from "~/i18n/resource";
import { CostInput } from "~/components/admin/shared/MoneyInput";
import { Field } from "~/components/ui/field";

type Costs = ReadonlyMap<string, number | null>;

/**
 * The costs to send: each SKU whose typed cost differs from the one the
 * merchant opened the dialog with, which goes along as `expectedCost`.
 */
export function bulkCostItems(variantIds: readonly string[], seen: Costs, typed: Costs): SkuCostItem[] {
  return variantIds.flatMap((variantId) => {
    const expectedCost = seen.get(variantId) ?? null;
    const cost = typed.has(variantId) ? typed.get(variantId) ?? null : expectedCost;
    return sameCost(cost, expectedCost) ? [] : [{ variantId, cost, expectedCost }];
  });
}

interface BulkCostDialogProps {
  /** The selected SKUs, with the costs the merchant sees (at most 100: one save). */
  variants: readonly InventoryVariant[];
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** After a refused save: reloads the list and resolves with its latest rows. */
  onReload: () => Promise<readonly InventoryVariant[]>;
}

/**
 * One cost per item for each selected SKU, or one for all of them, in a
 * single atomic save. Always mounted; the parent re-keys it per opening.
 */
export function BulkCostDialog({ variants, open, onClose, onSaved, onReload }: BulkCostDialogProps) {
  const t = useMessages(inventoryMessages);
  const r = useMessages(resourceMessages);
  // The rows as opened: a list refresh behind the dialog never moves them.
  const [rows] = useState(() => [...variants]);
  const [seen, setSeen] = useState<Costs>(() => new Map(rows.map((row) => [row.id, row.cost ?? null])));
  const [typed, setTyped] = useState<Costs>(seen);
  const [all, setAll] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [failure, setFailure] = useState<"conflict" | "failed" | null>(null);

  const ids = rows.map((row) => row.id);
  const items = bulkCostItems(ids, seen, typed);
  const tooMany = rows.length > SKU_COST_BATCH_LIMIT;
  const invalid = ids.some((id) => costProblem(typed.get(id) ?? null) !== null);
  const canSave = items.length > 0 && !invalid && !tooMany && !submitting && !reloading;

  const setCost = (id: string, cost: number | null) => {
    setTyped((current) => new Map(current).set(id, cost));
    setFailure(null);
  };

  const save = async () => {
    if (!canSave) return;
    setSubmitting(true);
    setFailure(null);
    try {
      await saveSkuCosts(items);
      toast.success(t("costsSaved"));
      onSaved();
      onClose();
    } catch (error) {
      setFailure(isSkuCostConflict(error) ? "conflict" : "failed");
    } finally {
      setSubmitting(false);
    }
  };

  /** Takes the latest cost of every SKU that changed elsewhere; typed costs of the others stay. */
  const reload = async () => {
    setReloading(true);
    try {
      const latest = new Map((await onReload()).map((row) => [row.id, row.cost ?? null]));
      const nextSeen = new Map(seen);
      const nextTyped = new Map(typed);
      for (const id of ids) {
        if (!latest.has(id) || sameCost(seen.get(id), latest.get(id))) continue;
        nextSeen.set(id, latest.get(id) ?? null);
        nextTyped.set(id, latest.get(id) ?? null);
      }
      setSeen(nextSeen);
      setTyped(nextTyped);
      setFailure(null);
    } catch {
      setFailure("failed");
    } finally {
      setReloading(false);
    }
  };

  const problemOf = (id: string) => {
    const problem = costProblem(typed.get(id) ?? null);
    return problem ? t(problem) : null;
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("costDialogTitle")}</DialogTitle>
          <DialogDescription>
            {rows.length === 1 ? t("costDialogDescriptionOne") : t("costDialogDescription", { count: rows.length })}
          </DialogDescription>
        </DialogHeader>

        <form
          id="inventory-bulk-cost-form"
          method="post"
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {failure ? (
            <Alert variant="destructive">
              <AlertDescription>
                <p>{t(failure === "conflict" ? "costChanged" : "costsFailed")}</p>
                {failure === "conflict" ? (
                  <Button type="button" variant="outline" size="sm" className="mt-2" loading={reloading} onClick={() => void reload()}>
                    {t("reloadCosts")}
                  </Button>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
          {tooMany ? (
            <p role="alert" className="text-body text-destructive">{t("costTooMany", { max: SKU_COST_BATCH_LIMIT })}</p>
          ) : null}

          {rows.length > 1 ? (
            <Field id="inventory-bulk-cost-all" label={t("setAllTo")}>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <CostInput id="inventory-bulk-cost-all" value={all} onValueChange={setAll} />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={all === null || costProblem(all) !== null}
                  onClick={() => {
                    setTyped(new Map(ids.map((id) => [id, all])));
                    setFailure(null);
                  }}
                >
                  {t("applyToAll")}
                </Button>
              </div>
            </Field>
          ) : null}

          <ul className="divide-y border-y">
            {rows.map((row) => {
              const name = [row.productName ?? t("unknownProduct"), row.optionLabel].filter(Boolean).join(" · ");
              const problem = problemOf(row.id);
              return (
                <li key={row.id} className="space-y-1 py-2">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-body font-medium">{row.productName ?? t("unknownProduct")}</p>
                      <p className="truncate text-body text-muted-foreground">
                        {row.optionLabel ? `${row.optionLabel} · ` : null}
                        <span className="font-mono">{row.sku}</span>
                      </p>
                    </div>
                    <div className="w-32 shrink-0">
                      <CostInput
                        value={typed.get(row.id) ?? null}
                        aria-label={t("costFor", { name })}
                        aria-invalid={problem ? true : undefined}
                        onValueChange={(cost) => setCost(row.id, cost)}
                      />
                    </div>
                  </div>
                  {problem ? <p className="text-end text-body text-destructive">{problem}</p> : null}
                </li>
              );
            })}
          </ul>
          <p className="text-body text-muted-foreground">{t("costHelp")}</p>
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{r("cancel")}</Button>
          <Button type="submit" form="inventory-bulk-cost-form" disabled={!canSave} loading={submitting}>
            {r("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
