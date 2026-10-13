import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ConversationProductSnapshot } from "@scalius/shared/conversation";
import { formatList } from "@scalius/shared/locale-words";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Field } from "~/components/ui/field";
import { Button } from "~/components/ui/button";
import { fetchProducts, productVariantsQueryOptions } from "~/lib/api-query-options/products";
import { getLocale, useMessages } from "~/i18n";
import { inboxMessages } from "~/i18n/inbox";

export function ConversationProductsDialog({ open, onOpenChange, onPick, selectedIds }: { open: boolean; onOpenChange: (open: boolean) => void; onPick: (product: ConversationProductSnapshot) => void; selectedIds: readonly string[] }) {
  const t = useMessages(inboxMessages);
  const [product, setProduct] = useState<{ id: string; name: string } | null>(null);
  const variants = useQuery({ ...productVariantsQueryOptions(product?.id ?? ""), enabled: open && Boolean(product) });
  return <Dialog open={open} onOpenChange={(next) => { if (!next) setProduct(null); onOpenChange(next); }}>
    <DialogContent><DialogHeader><DialogTitle>{t("addProduct")}</DialogTitle></DialogHeader>
      <Field label={t("product")}><SearchableSelect value={product?.id ?? ""} selectedLabel={product?.name}
        queryKey={["conversations", "product-picker"]} load={async ({ search, page }) => {
          const result = await fetchProducts({ search: search || undefined, page, limit: 20, status: "active" });
          return { options: result.products.map((item) => ({ value: item.id, label: item.name })), hasMore: page < result.pagination.totalPages };
        }} onValueChange={(id, option) => setProduct(option ? { id, name: option.label } : null)} /></Field>
      {product ? variants.isError ? <Button variant="outline" onClick={() => void variants.refetch()}>{t("retry")}</Button> : <Field label={t("variant")}>
        <SearchableSelect value="" busy={variants.isPending} disabled={variants.isPending} maxVisibleOptions={50}
          options={(variants.data?.variants ?? []).filter((variant) => !variant.deletedAt).map((variant) => ({ value: variant.id, label: formatList((variant.selectedOptions ?? []).map((option) => option.value), getLocale()) || variant.sku, disabled: selectedIds.includes(variant.id) }))}
          onValueChange={(id, option) => { if (!open || selectedIds.includes(id) || !option || !variants.data?.variants.some((variant) => variant.id === id && !variant.deletedAt)) return; onPick({ productId: product.id, skuId: id, title: product.name, variantLabel: option.label }); onOpenChange(false); setProduct(null); }} />
      </Field> : null}
    </DialogContent>
  </Dialog>;
}
