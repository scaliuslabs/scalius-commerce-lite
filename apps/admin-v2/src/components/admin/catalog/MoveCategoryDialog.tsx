import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { patchApiV1AdminCategoriesByIdParent } from "@scalius/api-client/sdk";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { apiData } from "@/lib/api";
import { getServerFnError } from "@/lib/api-helpers";
import { readAdminApiErrorCode, readCategoryRevisionConflict } from "@/lib/admin-api-error";
import { queryKeys } from "@/lib/query-keys";
import { categoryFormOptionsQueryOptions } from "@/lib/api-query-options/categories";
import { categoryPathLabel, indexCategories } from "@/lib/category-tree";
import { parentChoices } from "@/lib/category-parent-choices";
import { useMessages } from "~/i18n";
import { categoryFormMessages } from "~/i18n/category-form";

export interface MoveTarget {
  id: string;
  name: string;
  parentId: string | null;
  revision: number;
}

/** Moves a category (with everything under it) to another parent, from the list. */
export function MoveCategoryDialog({ target, onClose }: { target: MoveTarget | null; onClose: () => void }) {
  const t = useMessages(categoryFormMessages);
  const queryClient = useQueryClient();
  const { data } = useQuery({ ...categoryFormOptionsQueryOptions(), enabled: target !== null });
  const [parentId, setParentId] = useState<string | null>(target?.parentId ?? null);
  const [error, setError] = useState<string | null>(null);
  const categories = data?.categories ?? [];
  const byId = indexCategories(categories);
  const options = target ? parentChoices(target.id, categories).map((category) => ({
    value: category.id,
    label: categoryPathLabel(category.id, byId),
    keywords: [category.name],
  })) : [];

  const move = useMutation({
    mutationFn: () => apiData(patchApiV1AdminCategoriesByIdParent({
      path: { id: target!.id },
      body: { expectedRevision: target!.revision, parentId },
    })),
    onSuccess: () => {
      toast.success(t("moved"));
      onClose();
    },
    onError: (failure) => {
      if (readCategoryRevisionConflict(failure)) setError(t("moveConflict"));
      else if (readAdminApiErrorCode(failure) === "CATEGORY_PLACEMENT_REFUSED") setError(t("placementRefused"));
      else setError(getServerFnError(failure));
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.categories.all }),
  });

  const path = parentId ? categoryPathLabel(parentId, byId) : "";
  return (
    <Dialog open={target !== null} onOpenChange={(next) => !next && !move.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("moveTitle", { name: target?.name ?? "" })}</DialogTitle>
          <DialogDescription>{t("moveBody")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {error ? <p role="alert" className="text-body text-destructive">{error}</p> : null}
          <Label htmlFor="move-category-parent">{t("parentCategory")}</Label>
          <SearchableSelect
            id="move-category-parent"
            value={parentId ?? ""}
            options={options}
            selectedLabel={path || undefined}
            clearable
            triggerClassName="w-full"
            placeholder={t("topLevel")}
            searchPlaceholder={t("searchCategories")}
            emptyMessage={t("noCategoriesFound")}
            onValueChange={(next) => {
              setError(null);
              setParentId(next || null);
            }}
          />
          <p className="text-body text-muted-foreground">
            {t("path", { path: path ? `${path} › ${target?.name ?? ""}` : target?.name ?? "" })}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={move.isPending} onClick={onClose}>{t("cancel")}</Button>
          <Button
            type="button"
            loading={move.isPending}
            disabled={parentId === (target?.parentId ?? null)}
            onClick={() => move.mutate()}
          >
            {t("move")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
