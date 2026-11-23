import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { patchApiV1AdminProductsByIdSectionsBySection } from "@scalius/api-client/sdk";
import { apiData } from "~/lib/api";
import { useCommand } from "~/lib/use-command";
import { toast } from "~/lib/toast";
import { queryKeys } from "~/lib/query-keys";
import { getServerFnError } from "~/lib/api-helpers";
import { readProductRevisionConflict } from "~/lib/admin-api-conflicts";
import { useCurrency } from "~/hooks/use-currency";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
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
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Field, Inset } from "~/components/ui/field";
import { NumberInput } from "~/components/ui/number-input";
import { Skeleton } from "~/components/ui/skeleton";
import { OWN_SAVE_ATTRIBUTE } from "~/components/admin/shared/SaveBar";
import { useMessages } from "~/i18n";
import { productKitMessages, type ProductKitMessageKey } from "~/i18n/product-kits";
import { readProductKitRefusal } from "~/i18n/product-kit-refusals";
import { resourceMessages } from "~/i18n/resource";
import { CollapsibleCard } from "../CollapsibleCard";
import { productKitsQueryOptions, type ProductKit, type ProductKitComponent } from "../merchandising/section-api";
import { useProductSection } from "../merchandising/product-sections";
import { SkuPickerDialog, skuName, type SkuOption } from "./SkuPickerDialog";
import type { ProductRevisionHandle, ProductSkuSummary } from "./kit-types";

const KIT_ITEMS_MAX = 20;
const QUANTITY_MAX = 100;

/** One item of a bundle being edited. */
interface DraftItem {
  variantId: string;
  productName: string | null;
  sku: string | null;
  options: ReadonlyArray<{ name: string; value: string }>;
  quantity: number | null;
  price: number | null;
}

const fromComponent = (component: ProductKitComponent): DraftItem => ({
  variantId: component.variantId,
  productName: component.productName,
  sku: component.sku,
  options: component.options,
  quantity: component.quantity,
  price: component.price,
});

const fromOption = (option: SkuOption): DraftItem => ({
  variantId: option.variantId,
  productName: option.productName,
  sku: option.sku,
  options: option.options,
  quantity: 1,
  price: option.price,
});

interface BundleOffersCardProps {
  productId: string;
  /** The product's name: what buyers read as a bundle's title, with its options. */
  productName: string;
  /** The product's live SKUs: each may be made a bundle. */
  skus: ProductSkuSummary[];
  /** Which of them are bundles now (the product read, then this card's saves). */
  kitIds: ReadonlySet<string>;
  readOnly: boolean;
  /** The page's own save (fields, variants) is on its way: a bundle waits for it. */
  pageSaving: boolean;
  revision: ProductRevisionHandle;
}

/**
 * A SKU of this product made of SKUs of any products ("What's included"),
 * sold at its own price. The card lists the product's SKUs; a bundle shows
 * what the server prices from its items: its price, what the items add up
 * to, the saving, how many can be sold, and why none can. Edits save on
 * their own (a section with its own button), under the product's revision.
 * Closed, it says how many SKUs are bundles from the product read; its own
 * read waits until it opens.
 */
export default function BundleOffersCard({ productId, productName, skus, kitIds, readOnly, pageSaving, revision }: BundleOffersCardProps) {
  const t = useMessages(productKitMessages);
  const kitCount = skus.filter((sku) => kitIds.has(sku.id)).length;
  return (
    <CollapsibleCard
      id="product-bundle-offers"
      title={t("kitsTitle")}
      description={t("kitsHelp")}
      defaultOpen={kitCount > 0}
      summary={<p className="text-body text-muted-foreground">{t("kitsSummary", { count: kitCount })}</p>}
    >
      <BundleOffersBody productId={productId} productName={productName} skus={skus} readOnly={readOnly} pageSaving={pageSaving} revision={revision} />
    </CollapsibleCard>
  );
}

function BundleOffersBody({ productId, productName, skus, readOnly, pageSaving, revision }: Omit<BundleOffersCardProps, "kitIds">) {
  const t = useMessages(productKitMessages);
  const tr = useMessages(resourceMessages);
  const { data, isError, refetch } = useQuery(productKitsQueryOptions(productId));
  const kits = useMemo(() => new Map((data?.items ?? []).map((kit) => [kit.variantId, kit])), [data]);
  // Every open editor keeps its own draft: opening another never drops one.
  const [editing, setEditing] = useState<ReadonlySet<string>>(() => new Set());
  return (
    <div {...{ [OWN_SAVE_ATTRIBUTE]: "" }} className="flex flex-col gap-4">
      {data === undefined ? (
        isError ? (
          <p className="text-body text-muted-foreground">
            {t("kitsLoadFailed")}{" "}
            <Button type="button" variant="link" onClick={() => void refetch()}>{tr("retry")}</Button>
          </p>
        ) : <Skeleton className="h-24 w-full" />
      ) : skus.length === 0 ? (
        <p className="text-body text-muted-foreground">{t("noSkus")}</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {skus.map((sku) => (
            <li key={sku.id} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
              <BundleSkuRow
                productId={productId}
                buyerTitle={sku.label ? `${productName} – ${sku.label}` : productName}
                sku={sku}
                kit={kits.get(sku.id) ?? null}
                readOnly={readOnly}
                pageSaving={pageSaving}
                editing={editing.has(sku.id)}
                onEdit={(open) => setEditing((current) => {
                  const next = new Set(current);
                  if (open) next.add(sku.id);
                  else next.delete(sku.id);
                  return next;
                })}
                revision={revision}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BundleSkuRow({ productId, buyerTitle, sku, kit, readOnly, pageSaving, editing, onEdit, revision }: {
  productId: string;
  /** The offer's title as buyers read it. */
  buyerTitle: string;
  sku: ProductSkuSummary;
  kit: ProductKit | null;
  readOnly: boolean;
  pageSaving: boolean;
  editing: boolean;
  onEdit: (open: boolean) => void;
  revision: ProductRevisionHandle;
}) {
  const t = useMessages(productKitMessages);
  const title = sku.label || sku.sku;
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="flex flex-wrap items-center gap-2 text-body font-medium">
            <span className="wrap-anywhere">{title}</span>
            {kit ? <Badge variant="info">{t("bundle")}</Badge> : null}
          </p>
          <p className="text-body text-muted-foreground">
            {sku.label ? <span className="font-mono">{sku.sku}</span> : null}
            {sku.label ? " · " : null}
            {kit ? t("includedCount", { count: kit.components.length }) : t("soldAlone")}
          </p>
        </div>
        {readOnly || editing ? null : (
          <Button type="button" variant="outline" size="sm" onClick={() => onEdit(true)} aria-label={`${t(kit ? "editItems" : "makeBundle")}: ${title}`}>
            {t(kit ? "editItems" : "makeBundle")}
          </Button>
        )}
      </div>
      {editing ? (
        <BundleEditor productId={productId} sku={sku} kit={kit} pageSaving={pageSaving} onClose={() => onEdit(false)} revision={revision} />
      ) : kit ? (
        <BundleOutcome kit={kit} title={buyerTitle} />
      ) : null}
    </>
  );
}

/** Why buyers can't buy this bundle now, one line per item, or none. */
export function bundleProblems(kit: ProductKit, t: (key: ProductKitMessageKey, vars?: Record<string, string | number>) => string): string[] {
  const named = (component: ProductKitComponent | undefined) =>
    component ? skuName(component, t("unknownItem")) : t("unknownItem");
  const lines = kit.unavailable.map((issue) => t(`problem_${issue.reason}`, {
    name: named(kit.components.find((component) => component.variantId === issue.componentVariantId)),
  }));
  for (const component of kit.components) {
    if (component.problem === null && component.stock !== null && component.stock < component.quantity) {
      lines.push(t("problem_out_of_stock", { name: named(component) }));
    }
  }
  return lines;
}

/** The server's outcome for a saved bundle: price, compare-at, saving, how many can be sold, why not, and a preview. */
function BundleOutcome({ kit, title }: { kit: ProductKit; title: string }) {
  const t = useMessages(productKitMessages);
  const { fmt } = useCurrency();
  const problems = bundleProblems(kit, t);
  const blocked = kit.unavailable.length > 0 || kit.availableQuantity === 0;
  return (
    <Inset>
      <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="flex flex-col gap-1">
          <dt className="text-body text-muted-foreground">{t("price")}</dt>
          <dd className="text-body font-medium tabular-nums">{fmt(kit.price)}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-body text-muted-foreground">{t("itemsAddUpTo")}</dt>
          <dd className="text-body tabular-nums">{fmt(kit.compareAtPrice)}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-body text-muted-foreground">{t("saving")}</dt>
          <dd className="text-body tabular-nums">
            {kit.saving > 0 ? t("savingValue", { amount: fmt(kit.saving), percent: kit.savingPercent }) : "—"}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-body text-muted-foreground">{t("canSell")}</dt>
          <dd className="text-body tabular-nums">
            {kit.unavailable.length > 0 ? t("canSellCount", { count: 0 }) : kit.availableQuantity === null ? t("canSellAny") : t("canSellCount", { count: kit.availableQuantity })}
          </dd>
        </div>
      </dl>
      <p className="text-body text-muted-foreground">{kit.saving > 0 ? t("priceFromSku") : t("noSaving")}</p>
      {blocked ? (
        <Alert variant="warning">
          <AlertTitle>{t("cannotSell")}</AlertTitle>
          {problems.length > 0 ? (
            <AlertDescription>
              <ul className="flex flex-col gap-1">
                {problems.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </AlertDescription>
          ) : null}
        </Alert>
      ) : null}
      <div className="flex flex-col gap-1">
        <p className="text-body font-medium">{t("whatsIncluded")}</p>
        <ul className="flex flex-col gap-1">
          {kit.components.map((component) => (
            <li key={component.variantId} className="flex items-start justify-between gap-3 text-body">
              <span className="min-w-0">
                <span className="wrap-anywhere">{component.quantity} × {skuName(component, t("unknownItem"))}</span>
                {component.sku ? <span className="block font-mono text-muted-foreground">{component.sku}</span> : null}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{component.price === null ? "—" : fmt(component.price)}</span>
            </li>
          ))}
        </ul>
      </div>
      <BundlePreview kit={kit} title={title} />
      </div>
    </Inset>
  );
}

/** The offer row as buyers see it under the product's own offers, from the same read. */
export function BundlePreview({ kit, title }: { kit: ProductKit; title: string }) {
  const t = useMessages(productKitMessages);
  const { fmt } = useCurrency();
  return (
    <figure className="flex flex-col gap-1">
      <figcaption className="text-body text-muted-foreground">
        <span className="font-medium text-foreground">{t("preview")}</span> · {t("previewHelp")}
      </figcaption>
      <div data-testid="bundle-preview" className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-card p-3 shadow-card">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-body font-medium wrap-anywhere">{title}</p>
          <p className="flex flex-wrap gap-1">
            <Badge variant="info">{t("previewBundle")}</Badge>
            <Badge variant="secondary">{t("includedCount", { count: kit.components.length })}</Badge>
            {kit.savingPercent > 0 ? <Badge variant="success">{t("previewSave", { percent: kit.savingPercent })}</Badge> : null}
          </p>
        </div>
        <p className="flex items-baseline gap-2 tabular-nums">
          {kit.compareAtPrice > kit.price ? <s className="text-body text-muted-foreground">{fmt(kit.compareAtPrice)}</s> : null}
          <span className="text-body font-medium">{fmt(kit.price)}</span>
        </p>
      </div>
    </figure>
  );
}

interface KitWrite {
  variantId: string;
  components: Array<{ variantId: string; quantity: number }>;
}

/** Edits one SKU's items: add through the picker, set quantities, remove; saves the whole list. */
function BundleEditor({ productId, sku, kit, pageSaving, onClose, revision }: {
  productId: string;
  sku: ProductSkuSummary;
  kit: ProductKit | null;
  pageSaving: boolean;
  onClose: () => void;
  revision: ProductRevisionHandle;
}) {
  const t = useMessages(productKitMessages);
  const tr = useMessages(resourceMessages);
  const { fmt } = useCurrency();
  const queryClient = useQueryClient();
  const saved = useMemo(() => (kit?.components ?? []).map(fromComponent), [kit]);
  const [items, setItems] = useState<DraftItem[]>(saved);
  const [picking, setPicking] = useState(false);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [refusal, setRefusal] = useState<{ message: string; variantId: string | null } | null>(null);
  const title = sku.label || sku.sku;
  const changed = items.length !== saved.length || items.some((item, index) =>
    item.variantId !== saved[index]?.variantId || item.quantity !== saved[index]?.quantity);
  const invalid = items.some((item) => item.quantity === null || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > QUANTITY_MAX);

  // An open editor with changes keeps the page from being left by accident; it saves on its own.
  useProductSection({
    label: t("kitsTitle"),
    dirty: false,
    navigationDirty: changed,
    problems: null,
    prepareRebase: async () => () => () => {},
    changes: () => ({}),
    saved: () => {},
  });

  const save = useCommand<KitWrite, { aggregateRevision: number }>({
    subject: (input) => input.variantId,
    // The page's Save waits while this one is on its way (one revision, one writer at a time).
    onMutate: () => revision.writing(true),
    onSettled: () => revision.writing(false),
    mutationFn: ({ variantId, components }) => {
      const expectedAggregateRevision = revision.current();
      if (!expectedAggregateRevision) throw new Error(t("saveFailed"));
      return apiData(patchApiV1AdminProductsByIdSectionsBySection({
        path: { id: productId, section: "kits" },
        body: { section: "kits", expectedAggregateRevision, variantId, components },
      }));
    },
    onSuccess: async (result, input) => {
      revision.saved(result.aggregateRevision);
      revision.kitSaved(input.variantId, input.components.length > 0);
      toast.success(t(input.components.length > 0 ? "bundleSaved" : "bundleRemoved"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: productKitsQueryOptions(productId).queryKey }),
        queryClient.invalidateQueries({ queryKey: ["products", "sku-options"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.inventory.list() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.products.list() }),
      ]);
    },
  });

  const submit = () => {
    if (invalid || pageSaving) return;
    setRefusal(null);
    save.mutate({
      variantId: sku.id,
      components: items.map((item) => ({ variantId: item.variantId, quantity: item.quantity! })),
    }, {
      onSuccess: () => onClose(),
      onError: (error) => {
        const conflict = readProductRevisionConflict(error);
        if (conflict) {
          revision.conflict(conflict);
          setRefusal({ message: t("changedElsewhere"), variantId: null });
          return;
        }
        const kitRefusal = readProductKitRefusal(error);
        setRefusal(kitRefusal
          ? { message: kitRefusal.message, variantId: kitRefusal.variantId }
          : { message: getServerFnError(error, t("saveFailed")), variantId: null });
      },
    });
  };

  const onSave = () => {
    if (items.length === 0 && saved.length > 0) setConfirmEmpty(true);
    else submit();
  };

  const add = (options: SkuOption[]) => {
    setItems((current) => [...current, ...options.filter((option) => !current.some((item) => item.variantId === option.variantId)).map(fromOption)]);
    setAnnouncement(options.map((option) => t("itemAdded", { name: skuName(option, option.sku) })).join(" "));
  };
  const remove = (item: DraftItem) => {
    setItems((current) => current.filter((entry) => entry.variantId !== item.variantId));
    setAnnouncement(t("itemRemoved", { name: skuName(item, t("unknownItem")) }));
  };
  const itemRefusal = (item: DraftItem) => (refusal?.variantId === item.variantId ? refusal.message : null);
  const footerRefusal = refusal && !items.some((item) => item.variantId === refusal.variantId) ? refusal.message : null;

  return (
    <Inset>
      <div className="flex flex-col gap-3">
      <p className="text-body font-medium">{t("whatsIncluded")}</p>
      {items.length === 0 ? (
        <p className="text-body text-muted-foreground">{saved.length > 0 ? t("emptiedNote") : t("noItems")}</p>
      ) : (
        <ul className="flex flex-col gap-3" aria-label={t("whatsIncluded")}>
          {items.map((item) => {
            const name = skuName(item, t("unknownItem"));
            const problem = itemRefusal(item);
            const quantityInvalid = item.quantity === null || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > QUANTITY_MAX;
            return (
              <li key={item.variantId} className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="text-body wrap-anywhere">{name}</span>
                    <span className="text-body text-muted-foreground">
                      {item.sku ? <span className="font-mono">{item.sku}</span> : null}
                      {item.sku && item.price !== null ? " · " : null}
                      {item.price === null ? null : <span className="tabular-nums">{fmt(item.price)}</span>}
                    </span>
                  </div>
                  <Button type="button" variant="ghost" size="icon" aria-label={t("removeItem", { name })} onClick={() => remove(item)}>
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </div>
                {/* The server's refusal of this item, else why its quantity can't be saved, under the field and read with it. */}
                <Field label={t("quantity")} error={problem ?? (quantityInvalid ? t("quantityRange", { max: QUANTITY_MAX }) : undefined)} announceError>
                  <NumberInput
                    integer
                    className="w-32"
                    aria-label={t("quantityFor", { name })}
                    value={item.quantity}
                    onValueChange={(quantity) => setItems((current) => current.map((entry) => (entry.variantId === item.variantId ? { ...entry, quantity } : entry)))}
                  />
                </Field>
              </li>
            );
          })}
        </ul>
      )}
      <div>
        <Button type="button" variant="outline" disabled={items.length >= KIT_ITEMS_MAX} onClick={() => setPicking(true)}>
          <Plus className="size-4" aria-hidden="true" />
          {t("addItems")}
        </Button>
      </div>
      {footerRefusal ? <p role="alert" className="text-body text-destructive">{footerRefusal}</p> : null}
      {/* Why Save is off: the product's own save is on its way, or a quantity is out of range (said at its field). */}
      {pageSaving ? <p className="text-body text-muted-foreground">{t("waitForPageSave")}</p> : null}
      <div className="flex flex-wrap justify-end gap-2 border-t pt-3">
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>{tr("cancel")}</Button>
        <Button type="button" loading={save.isPending} disabled={invalid || pageSaving || !changed || (items.length === 0 && saved.length === 0)} onClick={onSave}>
          {t("saveBundle")}
        </Button>
      </div>
      <p className="sr-only" aria-live="polite">{announcement}</p>
      <SkuPickerDialog
        open={picking}
        onOpenChange={setPicking}
        mode="items"
        productId={productId}
        kitVariantId={sku.id}
        chosenIds={new Set(items.map((item) => item.variantId))}
        capacity={KIT_ITEMS_MAX - items.length}
        onAdd={add}
      />
      <AlertDialog open={confirmEmpty} onOpenChange={setConfirmEmpty}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("emptyTitle", { sku: title })}</AlertDialogTitle>
            <AlertDialogDescription>{t("emptyBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmEmpty(false); submit(); }}>{t("emptyConfirm")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </div>
    </Inset>
  );
}
