import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import {
  getApiV1AdminAttributes,
  putApiV1AdminAttributesCategorySetsByCategoryId,
} from "@scalius/api-client/sdk";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { SaveNotCompleted, useSaveBar } from "@/components/admin/shared/SaveBar";
import { apiData } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { categoryAttributeSetQueryOptions } from "@/lib/api-query-options/attributes";
import { categoryFormOptionsQueryOptions } from "@/lib/api-query-options/categories";
import { categoryPathLabel, indexCategories } from "@/lib/category-tree";
import { useMessages } from "~/i18n";
import { attributeTypeMessages } from "~/i18n/attribute-types";

interface OwnRow {
  attributeId: string;
  name: string;
  detail: string;
}

/** Categories may keep at most this many attributes of their own (the API's bound). */
const OWN_MAX = 90;

async function loadAttributes({ search, signal }: { search: string; signal: AbortSignal }) {
  const data = await apiData(getApiV1AdminAttributes({ query: { search: search || undefined, limit: 50, sort: "name", order: "asc" }, signal }));
  return {
    options: data.attributes.map((attribute) => ({ value: attribute.id, label: attribute.name, description: attribute.slug })),
    hasMore: false,
  };
}

/**
 * The attributes products in this category fill in: its own (add, order,
 * remove; saved with the page) after the ones it inherits from the categories
 * above it (edited there).
 */
export function CategoryAttributeSetCard({ categoryId, canEdit }: { categoryId: string; canEdit: boolean }) {
  const t = useMessages(attributeTypeMessages);
  const queryClient = useQueryClient();
  const { data } = useQuery(categoryAttributeSetQueryOptions(categoryId));
  const { data: lookup } = useQuery(categoryFormOptionsQueryOptions());
  const byId = useMemo(() => indexCategories(lookup?.categories ?? []), [lookup]);

  const loadedOwn = useMemo<OwnRow[] | undefined>(() => data?.attributes
    .filter((row) => row.inheritedFromCategoryId === null)
    .map((row) => ({ attributeId: row.attributeId, name: row.name, detail: t(`type_${row.valueType}`) + (row.unit ? ` · ${row.unit}` : "") })), [data, t]);
  const inherited = data?.attributes.filter((row) => row.inheritedFromCategoryId !== null) ?? [];
  const [saved, setSaved] = useState<OwnRow[] | undefined>(loadedOwn);
  const [own, setOwn] = useState<OwnRow[] | undefined>(loadedOwn);
  const ids = (rows: OwnRow[] | undefined) => (rows ?? []).map((row) => row.attributeId).join(",");
  const dirty = own !== undefined && ids(own) !== ids(saved);
  useEffect(() => {
    if (loadedOwn === undefined || dirty) return;
    setSaved(loadedOwn);
    setOwn(loadedOwn);
    // A fresh read replaces the list only while it has no edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedOwn]);

  useSaveBar({
    label: t("setLabel"),
    dirty: canEdit && dirty,
    save: async () => {
      const sent = own ?? [];
      if (sent.length > OWN_MAX) throw new SaveNotCompleted(t("setTooMany"));
      const result = await apiData(putApiV1AdminAttributesCategorySetsByCategoryId({
        path: { categoryId },
        body: { attributes: sent.map((row, sortOrder) => ({ attributeId: row.attributeId, sortOrder })) },
      }));
      setSaved(sent);
      queryClient.setQueryData(categoryAttributeSetQueryOptions(categoryId).queryKey, result);
      void queryClient.invalidateQueries({ queryKey: queryKeys.attributes.all });
    },
    discard: () => setOwn(saved),
  });

  const taken = new Set([...(own ?? []).map((row) => row.attributeId), ...inherited.map((row) => row.attributeId)]);
  const move = (index: number, step: -1 | 1) => {
    if (!own) return;
    const next = [...own];
    const [row] = next.splice(index, 1);
    next.splice(index + step, 0, row!);
    setOwn(next);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("attributeSet")}</CardTitle>
        <CardDescription>{t("attributeSetHelp")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {own === undefined ? <Skeleton className="h-16 w-full" /> : (
          <>
            {inherited.length === 0 && own.length === 0 ? (
              <p className="text-body text-muted-foreground">{t("noSetAttributes")}</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {inherited.map((row) => (
                  <li key={row.attributeId} className="flex items-center gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-body font-medium">{row.name}</p>
                      <p className="truncate text-body text-muted-foreground">
                        {t("fromCategory", { name: categoryPathLabel(row.inheritedFromCategoryId!, byId) || row.inheritedFromCategoryId! })}
                      </p>
                    </div>
                  </li>
                ))}
                {own.map((row, index) => (
                  <li key={row.attributeId} className="flex items-center gap-1 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-body font-medium">{row.name}</p>
                      <p className="truncate text-body text-muted-foreground">{row.detail}</p>
                    </div>
                    {canEdit ? (
                      <>
                        <Button type="button" variant="ghost" size="icon" disabled={index === 0} aria-label={t("moveUp", { name: row.name })} onClick={() => move(index, -1)}>
                          <ArrowUp className="h-4 w-4" />
                        </Button>
                        <Button type="button" variant="ghost" size="icon" disabled={index === own.length - 1} aria-label={t("moveDown", { name: row.name })} onClick={() => move(index, 1)}>
                          <ArrowDown className="h-4 w-4" />
                        </Button>
                        <Button type="button" variant="ghost" size="icon" aria-label={t("removeFromSet", { name: row.name })} onClick={() => setOwn(own.filter((item) => item.attributeId !== row.attributeId))}>
                          <X className="h-4 w-4" />
                        </Button>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {canEdit && own.length < OWN_MAX ? (
              <SearchableSelect
                id={`category-attribute-add-${categoryId}`}
                value=""
                load={loadAttributes}
                queryKey={[...queryKeys.attributes.all, "set-picker"]}
                triggerClassName="w-full"
                placeholder={t("addAttribute")}
                searchPlaceholder={t("searchAttributes")}
                emptyMessage={t("noAttributesFound")}
                onValueChange={(value, option) => {
                  if (!value || taken.has(value)) return;
                  setOwn([...own, { attributeId: value, name: option?.label ?? value, detail: option?.description ?? "" }]);
                }}
              />
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
