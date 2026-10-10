import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ProductForm, type ProductDraftReader } from "~/components/admin/ProductForm";
import { productFieldLabel } from "~/components/admin/product-form/utils";
import type { OptionMatrixEditorHandle } from "~/components/admin/product-form/variants/option-matrix-editor-model";
import { useOpenedOnce } from "~/hooks/use-opened-once";
import { SkuCostProvider, useSkuCostDraft } from "~/components/admin/product-form/sku-costs";
import { LoadingFallback } from "~/components/admin/shared/LoadingFallback";
import { categoryFormOptionsQueryOptions } from "~/lib/api-query-options/categories";
import { productQueryOptions } from "~/lib/api-query-options/products";
import { seoSettingsQueryOptions } from "~/lib/api-query-options/settings";
import type {
  ProductDetailDto as ProductDetail,
} from "~/lib/api-query-options/products";
import {
  DEFAULT_PRODUCT_CONDITION,
  type ProductFormValues,
  type Category,
} from "~/components/admin/product-form/types";
import { draftsFromView, viewFromDrafts } from "~/components/admin/product-form/buyer-inputs";
import { fulfilmentModeOf } from "~/components/admin/product-form/fulfilment-mode";
import { RouteErrorComponent } from "~/lib/route-error";
import { nullForAdminApiNotFound } from "~/lib/admin-api-error";
import { type ProductRevisionConflict } from "~/lib/admin-api-conflicts";
import { getServerFnError } from "~/lib/api-helpers";
import { translate } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { pageHead } from "~/i18n/page-titles";
import { INTENT_PREFETCH_MOUNT_GRACE_MS } from "~/lib/route-query-warming";
import { PresenceSlot, announceSave, presenceKey } from "~/lib/realtime/store";

/**
 * Fields that change together under the aggregate revision: the product's
 * own price and discount, and the variant composition (which carries the
 * prices once the product has options). Never mixed from two saves.
 */
const PRICING_GROUP = ["price", "discountType", "discountPercentage", "discountAmount", "variants"] as const;
const VARIANTS_FIELD = "variants";

const ProductRevisionConflictDialog = lazy(() => import("~/components/admin/product-form/ProductRevisionConflictDialog").then((module) => ({ default: module.ProductRevisionConflictDialog })));
const OptionMatrixEditor = lazy(() =>
  import("~/components/admin/product-form/variants/OptionMatrixEditor").then((module) => ({
    default: module.OptionMatrixEditor,
  })),
);

export const Route = createFileRoute("/admin/products/$productId/edit")({
  loader: async ({ params, context: { queryClient } }) => {
    const [product] = await Promise.all([
      // Fresh on open; a read the link's hover started a moment ago counts as
      // fresh, so the click doesn't fetch the whole product again. A save
      // invalidates it, and the server checks the revision on every write.
      queryClient.fetchQuery({ ...productQueryOptions(params.productId), staleTime: INTENT_PREFETCH_MOUNT_GRACE_MS }).catch(nullForAdminApiNotFound),
      queryClient.ensureQueryData(categoryFormOptionsQueryOptions()),
      queryClient.ensureQueryData(seoSettingsQueryOptions()).catch(() => null),
    ]);
    // A missing or trashed product says so and links back to the list (polish bar R2).
    if (!product || (product as ProductDetail).deletedAt) throw notFound();
  },
  head: () => pageHead("product"),
  errorComponent: RouteErrorComponent,
  component: EditProductPage,
});

function EditProductPage() {
  const { productId } = Route.useParams();
  const { data: product } = useSuspenseQuery(productQueryOptions(productId));
  const { data: categoryData } = useSuspenseQuery(categoryFormOptionsQueryOptions());
  return (
    <ProductEditor
      key={productId}
      productId={productId}
      initialProduct={product as ProductDetail}
      categories={categoryData.categories as Category[]}
    />
  );
}

/** The editor's values for a saved product. */
function toFormValues(product: ProductDetail): ProductFormValues {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    price: product.price,
    categoryId: product.categoryId ?? "",
    slug: product.slug,
    metaTitle: product.metaTitle,
    metaDescription: product.metaDescription,
    canonicalPath: product.canonicalPath,
    noIndex: product.noIndex,
    excludeFromSitemap: product.excludeFromSitemap,
    salesChannelIds: product.salesChannelIds,
    productCondition: product.productCondition ?? DEFAULT_PRODUCT_CONDITION,
    isActive: product.isActive,
    discountType: (product.discountType || "percentage") as "percentage" | "flat",
    discountPercentage: product.discountPercentage || 0,
    discountAmount: product.discountAmount || 0,
    freeDelivery: product.freeDelivery,
    slugEdited: true,
    media: [...(product.media || [])]
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((item) => ({
        ...item,
        effectiveAltText: item.altText,
        altText: item.contextualAltText ?? "",
      })),
    attributes: product.attributes || [],
    additionalInfo: (product.additionalInfo || []).map((item) => ({ ...item })),
    fulfillmentKind: fulfilmentModeOf(product.variants),
    isGiftCard: product.isGiftCard,
    warrantyPolicyId: product.warrantyPolicyId ?? null,
    brandId: product.brandId ?? null,
    customizationSchema: draftsFromView(product.customizationSchema),
  } as ProductFormValues;
}

/**
 * Options and SKUs as saved, to tell whether someone else changed them. Costs
 * are left out: they are saved on their own and check their own conflicts.
 */
function variantsSignature(product: ProductDetail): string {
  return JSON.stringify([product.options, product.variants.map(({ cost: _cost, ...variant }) => variant)]);
}

function ProductEditor({ productId, initialProduct, categories }: {
  productId: string;
  initialProduct: ProductDetail;
  categories: Category[];
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [formSnapshot, setFormSnapshot] = useState(initialProduct);
  const [matrixSnapshot, setMatrixSnapshot] = useState(initialProduct);
  const [matrixGeneration, setMatrixGeneration] = useState(0);
  const [aggregateRevision, setAggregateRevision] = useState(initialProduct.aggregateRevision);
  const [formGeneration, setFormGeneration] = useState(0);
  const [revisionConflict, setRevisionConflict] = useState<ProductRevisionConflict | null>(null);
  const [isConflictOpen, setIsConflictOpen] = useState(false);
  const conflictMounted = useOpenedOnce(isConflictOpen);
  const [isReloadingLatest, setIsReloadingLatest] = useState(false);
  const [reloadLatestError, setReloadLatestError] = useState<string | null>(null);
  const [matrixDirty, setMatrixDirty] = useState(false);
  const [matrixSaving, setMatrixSaving] = useState(false);
  const [matrixIssue, setMatrixIssue] = useState<string | null>(null);
  const currentMatrix = useRef({ dirty: matrixDirty, snapshot: matrixSnapshot });
  currentMatrix.current = { dirty: matrixDirty, snapshot: matrixSnapshot };
  const matrixRef = useRef<OptionMatrixEditorHandle>(null);
  const draftRef = useRef<ProductDraftReader | null>(null);
  // Cost per item: typed costs outlive the variant editor's remounts; saved with its Save.
  const costs = useSkuCostDraft(initialProduct.variants);
  const costsRef = useRef(costs);
  costsRef.current = costs;
  // Fields both people changed: the merchant's edits can't be applied automatically.
  const [overlap, setOverlap] = useState<string[] | null>(null);

  const updateRevision = useCallback((revision: number) => {
    setAggregateRevision((current) => Math.max(current, revision));
  }, []);

  const reloadLatest = useCallback(async () => {
    setIsReloadingLatest(true);
    setReloadLatestError(null);
    try {
      const latest = await queryClient.fetchQuery({ ...productQueryOptions(productId), staleTime: 0 }) as ProductDetail;
      if (latest.deletedAt) {
        void navigate({ to: "/admin/products" });
        return;
      }
      setFormSnapshot(latest);
      setMatrixSnapshot(latest);
      setAggregateRevision(latest.aggregateRevision);
      setFormGeneration((value) => value + 1);
      setMatrixGeneration((value) => value + 1);
      costsRef.current.reset(latest.variants);
      setMatrixDirty(false);
      setMatrixIssue(null);
      setRevisionConflict(null);
      setOverlap(null);
      setIsConflictOpen(false);
    } catch (error) {
      setReloadLatestError(getServerFnError(error, translate(productMessages, "reloadFailed")));
    } finally {
      setIsReloadingLatest(false);
    }
  }, [navigate, productId, queryClient]);

  const refreshMatrix = useCallback(async () => {
    const latest = await queryClient.fetchQuery({ ...productQueryOptions(productId), staleTime: 0 }) as ProductDetail;
    setMatrixSnapshot(latest);
    setAggregateRevision(latest.aggregateRevision);
    setMatrixGeneration((value) => value + 1);
    // Costs without a typed change follow the latest (a receipt may have averaged them).
    costsRef.current.sync(latest.variants);
  }, [productId, queryClient]);

  const handleProductSaved = useCallback((values: ProductFormValues, revision: number) => {
    setFormSnapshot((current) => ({
      ...current,
      name: values.name,
      slug: values.slug,
      description: values.description,
      price: values.price ?? 0,
      categoryId: values.categoryId,
      brandId: values.brandId,
      isActive: values.isActive,
      media: values.media.map(({ effectiveAltText, altText, ...item }) => ({
        ...item,
        altText: altText.trim() || effectiveAltText,
        contextualAltText: altText.trim() || null,
      })),
      customizationSchema: viewFromDrafts(values.customizationSchema) as ProductDetail["customizationSchema"],
      // One kind for the product: every live SKU now has it (a later conflict compares against this).
      variants: values.fulfillmentKind === "mixed"
        ? current.variants
        : current.variants.map((variant) => (variant.deletedAt ? variant : { ...variant, fulfillmentKind: values.fulfillmentKind as "physical" | "service" })),
      aggregateRevision: revision,
    }));
    setAggregateRevision(revision);
    // A variant draft is saved next by the page, against this new revision.
    if (!matrixDirty) void refreshMatrix();
  }, [matrixDirty, refreshMatrix]);

  const defaultValues = toFormValues(formSnapshot);

  /**
   * "Apply my changes": load the other save and put the merchant's changed fields back on
   * top, still unsaved. When the other save changed the same fields (or the variants the
   * merchant is editing), nothing is applied; the dialog names those fields instead.
   */
  /**
   * The save met a newer revision: merge the draft onto the other save
   * (base = what this editor loaded, theirs = the latest, mine = the draft).
   * Different fields combine; a field both changed goes to the side-by-side
   * choice; a clash in the variants or sections opens the conflict dialog.
   * Returns the revision to save at, or null.
   */
  const mergeOnConflict = useCallback(async (conflict: ProductRevisionConflict): Promise<number | null> => {
    const reader = draftRef.current;
    if (!reader || conflict.currentRevision === null) return null;
    const latest = await queryClient.fetchQuery({ ...productQueryOptions(productId), staleTime: 0 }) as ProductDetail;
    if (latest.deletedAt) return null;
    const sections = await reader().prepareSectionsRebase();
    const draft = reader();
    const matrix = currentMatrix.current;
    const before = { ...toFormValues(formSnapshot), [VARIANTS_FIELD]: variantsSignature(matrix.snapshot) };
    const after = { ...toFormValues(latest), [VARIANTS_FIELD]: variantsSignature(latest) };
    const mine: Record<string, unknown> = { ...before };
    for (const key of draft.changed) mine[key] = draft.values[key];
    // An unsaved variant draft counts as a change to the composition.
    if (matrix.dirty) mine[VARIANTS_FIELD] = `${before[VARIANTS_FIELD]}:draft`;
    const { clashRows, mergeDisplayValue, mergeWords, requestMergeChoice, threeWayMerge } = await import("~/lib/merge-document");
    const result = threeWayMerge(before, after, mine, { deep: false, coupled: { pricing: PRICING_GROUP } });
    const blocked = sections.overlaps.length > 0 || result.clashes.some((clash) => clash.paths.includes(VARIANTS_FIELD));
    const labels = result.clashes.flatMap((clash) => clash.paths.filter((path) => path !== VARIANTS_FIELD)
      .map((path) => productFieldLabel(path as keyof ProductFormValues)));
    const openDialog = () => {
      setRevisionConflict(conflict);
      setOverlap([...new Set([...sections.overlaps, ...labels, ...(blocked && matrix.dirty ? [translate(productMessages, "variants")] : [])])]);
      setIsConflictOpen(true);
    };
    if (blocked) {
      openDialog();
      return null;
    }
    let keep: Array<keyof ProductFormValues> = draft.changed;
    const restore: Partial<Record<keyof ProductFormValues, unknown>> = {};
    if (result.clashes.length > 0) {
      const words = mergeWords();
      const show = (path: string, value: unknown) => path === "categoryId"
        ? categories.find((category) => category.id === value)?.name ?? mergeDisplayValue(value, words)
        : mergeDisplayValue(value, words);
      const choices = await requestMergeChoice({
        rows: clashRows(result.clashes, (path) => productFieldLabel(path as keyof ProductFormValues), show),
      });
      if (!choices) {
        openDialog();
        return null;
      }
      const theirsKeys = new Set(result.clashes.filter((clash) => choices[clash.key] !== "mine").flatMap((clash) => clash.paths));
      keep = draft.changed.filter((key) => !theirsKeys.has(key));
      // "Mine" for a coupled group keeps the whole group as the draft has it:
      // the other save's part of it (a discount beside my price) is undone
      // too, never mixed with mine.
      for (const clash of result.clashes) {
        if (choices[clash.key] !== "mine") continue;
        for (const path of clash.paths) {
          const key = path as keyof ProductFormValues;
          if (path !== VARIANTS_FIELD && !draft.changed.includes(key)) restore[key] = clash.mine[path];
        }
      }
    }
    setFormSnapshot(latest);
    setAggregateRevision(latest.aggregateRevision);
    sections.apply();
    draft.rebase(toFormValues(latest), keep, restore as Partial<ProductFormValues>);
    costsRef.current.sync(latest.variants);
    if (!matrix.dirty) {
      setMatrixSnapshot(latest);
      setMatrixGeneration((value) => value + 1);
    }
    setRevisionConflict(null);
    setOverlap(null);
    return latest.aggregateRevision;
  }, [categories, formSnapshot, productId, queryClient]);

  // Presence: which fields this draft changed (for a clean merge of another save).
  const readChangedFields = useCallback(() => draftRef.current?.().changed ?? [], []);

  const applyMineToLatest = useCallback(async () => {
    if (!draftRef.current) return;
    setIsReloadingLatest(true);
    setReloadLatestError(null);
    try {
      const latest = await queryClient.fetchQuery({ ...productQueryOptions(productId), staleTime: 0 }) as ProductDetail;
      if (latest.deletedAt) {
        void navigate({ to: "/admin/products" });
        return;
      }
      const sections = await draftRef.current().prepareSectionsRebase();
      // Read after the requests, so edits made while loading are included in the check.
      const draft = draftRef.current();
      const before = toFormValues(formSnapshot);
      const after = toFormValues(latest);
      const same = (key: keyof ProductFormValues) => JSON.stringify(before[key]) === JSON.stringify(after[key]);
      const clashes = draft.changed.filter((key) => !same(key));
      const matrix = currentMatrix.current;
      const variantsChanged = matrix.dirty && variantsSignature(matrix.snapshot) !== variantsSignature(latest);
      if (clashes.length > 0 || variantsChanged || sections.overlaps.length > 0) {
        setOverlap([...sections.overlaps, ...clashes.map(productFieldLabel), ...(variantsChanged ? [translate(productMessages, "variants")] : [])]);
        return;
      }
      setFormSnapshot(latest);
      setAggregateRevision(latest.aggregateRevision);
      sections.apply();
      draft.rebase(after);
      // Typed costs keep the cost they were typed over, so one changed meanwhile is caught on save.
      costsRef.current.sync(latest.variants);
      if (!matrix.dirty) {
        setMatrixSnapshot(latest);
        setMatrixGeneration((value) => value + 1);
      }
      setRevisionConflict(null);
      setIsConflictOpen(false);
    } catch (error) {
      setReloadLatestError(getServerFnError(error, translate(productMessages, "reloadFailed")));
    } finally {
      setIsReloadingLatest(false);
    }
  }, [formSnapshot, navigate, productId, queryClient]);

  return (
    <SkuCostProvider store={costs}>
    {/* `contents`: marks the editor for field presence without adding a box. */}
    <div data-presence-root={presenceKey("product", productId)} className="contents">
      <ProductForm
        key={formGeneration}
        categories={categories}
        defaultValues={defaultValues}
        isEdit
        aggregateRevision={aggregateRevision}
        revisionConflict={revisionConflict}
        onAggregateRevisionChange={updateRevision}
        onRevisionConflict={(conflict) => {
          setRevisionConflict(conflict);
          setOverlap(null);
          setIsConflictOpen(true);
        }}
        resolveRevisionConflict={mergeOnConflict}
        onOpenRevisionConflict={() => setIsConflictOpen(true)}
        draftRef={draftRef}
        onProductSaved={(values, revision) => {
          // The fields this save changed against the last saved version (names, never values).
          const before = toFormValues(formSnapshot);
          const changed = (Object.keys(values) as Array<keyof ProductFormValues>)
            .filter((key) => JSON.stringify(values[key]) !== JSON.stringify(before[key]));
          handleProductSaved(values, revision);
          announceSave(presenceKey("product", productId), revision, changed);
        }}
        optionMatrixIssue={matrixIssue}
        optionMatrixDirty={matrixDirty}
        optionMatrixSaving={matrixSaving}
        matrixRef={matrixRef}
        variantIds={matrixSnapshot.variants.filter((variant) => !variant.deletedAt).map((variant) => variant.id)}
        customizationSchemaInvalid={formSnapshot.customizationSchemaInvalid}
        brandName={formSnapshot.brandName}
        presence={(dirty) => (
          <PresenceSlot
            presenceKey={presenceKey("product", productId)}
            revision={aggregateRevision}
            dirty={dirty}
            changedFields={readChangedFields}
            onLoadLatest={() => void (dirty ? applyMineToLatest() : reloadLatest())}
          />
        )}
        onDiscard={() => {
          if (revisionConflict) {
            void reloadLatest();
            return;
          }
          setFormGeneration((value) => value + 1);
          setMatrixGeneration((value) => value + 1);
          costs.reset();
          setMatrixDirty(false);
          setMatrixIssue(null);
        }}
        optionManager={({ skuImages, productName, productPrice, isActive, onPricesChange, fulfilmentMode }) => (
          <Suspense fallback={<LoadingFallback height="h-48" />}>
            <OptionMatrixEditor
              requirePositivePrice={isActive}
              ref={matrixRef}
              key={`matrix-${matrixGeneration}`}
              productId={productId}
              productName={productName}
              productPrice={productPrice}
              onPricesChange={onPricesChange}
              options={matrixSnapshot.options}
              variants={matrixSnapshot.variants}
              images={skuImages}
              aggregateRevision={aggregateRevision}
              onAggregateRevisionChange={updateRevision}
              onDirtyChange={setMatrixDirty}
              onDraftIssueChange={setMatrixIssue}
              onSavingChange={setMatrixSaving}
              onRevisionConflict={(conflict) => {
                setRevisionConflict(conflict);
                setOverlap(null);
                setIsConflictOpen(true);
              }}
              onSaved={() => void refreshMatrix()}
              fulfilmentMode={fulfilmentMode}
            />
          </Suspense>
        )}
      />
    </div>
      {conflictMounted ? (
        <Suspense fallback={null}>
          <ProductRevisionConflictDialog
            open={isConflictOpen}
            conflict={revisionConflict}
            isReloading={isReloadingLatest}
            reloadError={reloadLatestError}
            onOpenChange={setIsConflictOpen}
            changedFields={isConflictOpen ? [
              ...(draftRef.current?.().changed ?? []).map(productFieldLabel),
              ...(draftRef.current?.().changedSections ?? []),
            ] : []}
            variantsChanged={matrixDirty}
            overlap={overlap}
            onApplyMine={applyMineToLatest}
            onReloadLatest={reloadLatest}
            onProductUnavailable={() => void navigate({ to: "/admin/products" })}
          />
        </Suspense>
      ) : null}
    </SkuCostProvider>
  );
}
