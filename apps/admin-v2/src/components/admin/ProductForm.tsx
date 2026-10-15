import React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useWatch, type UseFormReturn } from "react-hook-form";
import { Link } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { ErrorBoundary } from "./ErrorBoundary";
import { Form } from "../ui/form";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { ConfirmDialog } from "./shared/ConfirmDialog";
import { useFieldErrorLines } from "./shared/use-form-save-bar";
import { useFormWithRefusals } from "~/lib/input-refusals";
import { sortedUniqueStrings } from "~/lib/form-values";
import {
  SaveBarProvider,
  SaveErrorBanner,
  SaveNotCompleted,
  useSaveBar,
  useSaveScope,
} from "./shared/SaveBar";
import { PageHeader } from "./resource/PageHeader";
import { ReadOnlyNotice } from "./resource/ReadOnlyNotice";
import { appActionKey, useAppActionRunner } from "./apps/ui/AppActions";
import { AppResourceCards } from "./apps/ui/AppResourceCards";
import { RelatedObjectsCard } from "./objects/RelatedObjectsCard";
import type { RelatedObjectRecord } from "@scalius/shared/plugins/objects";
import { ProductStatusBadge } from "./product-list/ProductStatusBadge";
import { ProductPager } from "./product-form/ProductPager";
import {
  AdditionalSectionsCard,
  TitleDescriptionSection,
} from "./product-form/TitleDescriptionSection";
import { ProductImagesSection } from "./product-form/ProductImagesSection";
import { PricingCard } from "./product-form/PricingCard";
import { AttributesSection } from "./product-form/AttributesSection";
import { ProductSearchListing } from "./product-form/ProductSearchListing";
import { ShippingCard } from "./product-form/ShippingCard";
import { CollapsibleCard } from "./product-form/CollapsibleCard";
import { ProductEditorSlotsContext, type ProductEditorSlots } from "./product-form/editor-slots";
import { DigitalDeliveryCard } from "./product-form/DigitalDeliveryCard";
import { GiftCardProductCard } from "./product-form/GiftCardProductCard";
import { StatusCard } from "./product-form/StatusCard";
import { ProductKindRulesContext, productKindRules } from "./product-form/product-kind-rules";
import { OrganizationCard } from "./product-form/OrganizationCard";
import { WarrantyCard } from "./product-form/WarrantyCard";
import { PublishingCard } from "./product-form/PublishingCard";
import { useProductSubmit } from "./product-form/hooks/useProductSubmit";
import { ProductSectionsProvider, useProductSections } from "./product-form/merchandising/product-sections";
import { LoadingFallback } from "./shared/LoadingFallback";
import { problemLine, productFieldLabel } from "./product-form/utils";
import { autoHandleFor } from "./search-listing/SearchListingCard";
import {
  DEFAULT_PRODUCT_CONDITION,
  productFormSchema,
  type Category,
  type ProductFormValues,
} from "./product-form/types";
import { useStorefrontUrl } from "@/hooks/use-storefront-url";
import { useCatalogActionPermissions } from "@/hooks/use-catalog-action-permissions";
import { useDuplicateProduct, useTrashProduct } from "@/lib/api-mutations/products";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { resourceMessages } from "~/i18n/resource";
import { saveBarMessages } from "~/i18n/save-bar";
import type { ProductRevisionConflict } from "@/lib/admin-api-conflicts";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type {
  OptionMatrixEditorHandle,
  ProductCreateComposition,
  ProductFulfilmentMode,
  VariantPriceRange,
} from "./product-form/variants/option-matrix-editor-model";
import type { ProductSkuImageChoice } from "@/lib/api-query-options/products";
import { LazyCustomFieldsCard } from "./custom-fields/LazyCustomFieldsCard";
import { useTranslateMenuItem } from "./translations/TranslateMenuItem";
import { richTextOrNull } from "~/lib/rich-text-value";
import { Page } from "~/components/admin/resource/Page";

// The product page's own cards load after the editor, off its first download.
const BuyerInputsCard = React.lazy(() => import("./product-form/BuyerInputsCard").then((module) => ({ default: module.BuyerInputsCard })));
const loadCards = () => import("./product-form/merchandising/cards");
const ContentBlocksCard = React.lazy(() => loadCards().then((cards) => ({ default: cards.ContentBlocksCard })));
const BundlesCard = React.lazy(() => loadCards().then((cards) => ({ default: cards.BundlesCard })));
const ProductPageCard = React.lazy(() => loadCards().then((cards) => ({ default: cards.ProductPageCard })));

interface ProductFormProps {
  relatedObjects?: RelatedObjectRecord[];
  categories: Category[];
  defaultValues?: Partial<ProductFormValues>;
  isEdit?: boolean;
  aggregateRevision?: number;
  revisionConflict?: ProductRevisionConflict | null;
  onAggregateRevisionChange?: (revision: number) => void;
  onRevisionConflict?: (conflict: ProductRevisionConflict) => void;
  /** Merges a stale save onto the other one and returns the revision to retry at (useProductSubmit). */
  resolveRevisionConflict?: (conflict: ProductRevisionConflict) => Promise<number | null>;
  onOpenRevisionConflict?: () => void;
  onProductSaved?: (values: ProductFormValues, aggregateRevision: number) => void;
  optionManager: (context: {
    readOnly: boolean;
    skuImages: ProductSkuImageChoice[];
    productName: string;
    productPrice: number;
    isActive: boolean;
    /** The variant editor reports its price range here; with options, variants carry the prices. */
    onPricesChange: (range: VariantPriceRange | null) => void;
    /** The Fulfilment select: one kind for every SKU, or per variant (a column in the table). */
    fulfilmentMode: ProductFulfilmentMode;
  }) => React.ReactNode;
  /** The variant editor rendered by `optionManager`. */
  matrixRef: React.RefObject<OptionMatrixEditorHandle | null>;
  createComposition?: ProductCreateComposition | null;
  optionMatrixIssue?: string | null;
  optionMatrixDirty?: boolean;
  optionMatrixNavigationDirty?: boolean;
  optionMatrixSaving?: boolean;
  /** Saved SKUs, for printing their labels from the page's menu. */
  variantIds?: string[];
  /** Reads and rebases the mounted draft after a conflict. */
  draftRef?: React.MutableRefObject<ProductDraftReader | null>;
  /** Throws away the product and variant drafts (the route remounts them from the last save). */
  onDiscard: () => void;
  /** The saved buyer inputs couldn't be read (a product error, never "no inputs"). */
  customizationSchemaInvalid?: boolean;
  /** The saved brand's name, for the brand picker. */
  brandName?: string | null;
  /** The avatars for the header's presence slot (realtime presence), given whether this page has unsaved changes. */
  presence?: (dirty: boolean, readOnly: boolean) => React.ReactNode;
}

/** Reads the unsaved fields and rebases without unmounting the section or SKU editors. */
export type ProductDraftReader = () => {
  changed: Array<keyof ProductFormValues>;
  changedSections: string[];
  /** The draft as it stands (for the three-way merge). */
  values: ProductFormValues;
  prepareSectionsRebase: ReturnType<typeof useProductSections>["prepareRebase"];
  /**
   * Puts the latest saved values under the draft; `keep` names the changed
   * fields to keep (all by default). `restore` sets fields the draft did not
   * change back to a value, as unsaved changes (a coupled group the merchant
   * kept whole: the other save's part of it is undone too).
   */
  rebase: (latest: ProductFormValues, keep?: ReadonlyArray<keyof ProductFormValues>, restore?: Partial<ProductFormValues>) => void;
};

/** The one product page: add, edit, or view (without products.edit). */
export function ProductForm(props: ProductFormProps) {
  const t = useMessages(productMessages);
  const r = useMessages(resourceMessages);
  return (
    <ErrorBoundary
      fallback={
        <p className="p-4 text-center text-body text-muted-foreground">
          {r("loadFailed")}{" "}
          <Button type="button" variant="link" onClick={() => window.location.reload()}>
            {r("retry")}
          </Button>
        </p>
      }
    >
      {/* The same contextual save bar as every editor; a new product names itself. */}
      <SaveBarProvider
        unsavedLabel={props.isEdit ? undefined : t("unsavedProduct")}
        savedMessage={t(props.isEdit ? "productSaved" : "productAdded")}
      >
        <ProductEditor {...props} />
      </SaveBarProvider>
    </ErrorBoundary>
  );
}

function ProductEditor({
  relatedObjects,
  categories,
  defaultValues,
  isEdit = false,
  aggregateRevision,
  revisionConflict = null,
  onAggregateRevisionChange,
  onRevisionConflict,
  resolveRevisionConflict,
  onOpenRevisionConflict,
  onProductSaved,
  optionManager,
  matrixRef,
  createComposition,
  optionMatrixIssue = null,
  optionMatrixDirty = false,
  optionMatrixNavigationDirty = optionMatrixDirty,
  optionMatrixSaving = false,
  variantIds = [],
  draftRef,
  onDiscard,
  customizationSchemaInvalid = false,
  brandName = null,
  presence,
}: ProductFormProps) {
  const t = useMessages(productMessages);
  const r = useMessages(resourceMessages);
  const s = useMessages(saveBarMessages);
  const { getStorefrontPath } = useStorefrontUrl();
  const { products: can } = useCatalogActionPermissions();
  // Server checks stay authoritative; this only keeps viewers from editing.
  const readOnly = isEdit ? !can.canEdit : !can.canCreate;
  const latestReadOnly = React.useRef(readOnly);
  latestReadOnly.current = readOnly;
  const [trashOpen, setTrashOpen] = React.useState(false);
  const duplicate = useDuplicateProduct();
  const trash = useTrashProduct();
  const queryClient = useQueryClient();
  // Content blocks, bundles and the page template save on their own, under the same revision.
  const sections = useProductSections();
  // The old Additional sections tabs were saved as blocks: this save removes the originals.
  const tabsMoved = React.useRef(false);

  const form = useFormWithRefusals<ProductFormValues>({
    resolver: zodResolver(productFormSchema),
    // Check a field when the merchant leaves it, not while they type.
    mode: "onBlur",
    defaultValues: {
      name: "",
      price: null,
      categoryId: "",
      isActive: false,
      discountType: "percentage",
      discountPercentage: 0,
      discountAmount: 0,
      freeDelivery: false,
      metaTitle: null,
      metaDescription: null,
      noIndex: false,
      excludeFromSitemap: false,
      productCondition: DEFAULT_PRODUCT_CONDITION,
      slug: "",
      media: [],
      slugEdited: false,
      variantPriced: false,
      // Set back to "none" by the Pricing card whenever it changes: without a default that is a change from the load.
      compareAtProblem: null,
      attributes: [],
      additionalInfo: [],
      fulfillmentKind: "physical",
      isGiftCard: false,
      warrantyPolicyId: null,
      brandId: null,
      customizationSchema: [],
      ...defaultValues,
      salesChannelIds: defaultValues?.salesChannelIds ? sortedUniqueStrings(defaultValues.salesChannelIds) : null,
      // Empty is one value: a saved "<p></p>" is not a change from nothing.
      description: richTextOrNull(defaultValues?.description),
    },
  });

  const {
    isSubmitting,
    submit,
    mediaRemovalConflict,
    confirmMediaRemoval,
    cancelMediaRemoval,
  } = useProductSubmit({
    isEdit,
    productId: defaultValues?.id,
    form,
    aggregateRevision,
    onAggregateRevisionChange,
    onRevisionConflict,
    resolveRevisionConflict,
    onProductSaved,
    createComposition,
    onVariantIssue: (path, message) => matrixRef.current?.showServerIssue(path, message) ?? null,
    onCompositionSaved: (revision) => matrixRef.current?.compositionSaved(revision),
  });
  const productFormDirty = form.formState.isDirty;
  // Read while rendering so react-hook-form keeps tracking which fields changed.
  const dirtyFields = form.formState.dirtyFields;

  // Rebase only the form values: section and SKU editors keep their mounted drafts.
  if (draftRef) {
    draftRef.current = () => ({
      changedSections: sections.dirtyHandles().map((handle) => handle.label),
      prepareSectionsRebase: sections.prepareRebase,
      values: form.getValues(),
      rebase: (latest, keep, restore) => {
        const values = form.getValues();
        const changed = Object.keys(form.formState.dirtyFields) as Array<keyof ProductFormValues>;
        const baseline = { ...form.formState.defaultValues, ...latest };
        form.reset({ ...baseline, salesChannelIds: baseline.salesChannelIds ? sortedUniqueStrings(baseline.salesChannelIds) : null });
        for (const key of changed) {
          if (keep && !keep.includes(key)) continue;
          form.setValue(key, values[key] as never, { shouldDirty: true });
        }
        for (const [key, value] of Object.entries(restore ?? {}) as Array<[keyof ProductFormValues, unknown]>) {
          if (!changed.includes(key)) {
            const next = key === "salesChannelIds" && Array.isArray(value) ? sortedUniqueStrings(value as string[]) : value;
            form.setValue(key, next as never, { shouldDirty: true });
          }
        }
      },
      changed: (Object.keys(dirtyFields) as Array<keyof ProductFormValues>)
        .filter((key) => key !== "slugEdited" && key !== "variantPriced"),
    });
  }
  // With options the variants carry the prices: the product price follows the cheapest one,
  // as the server keeps it, and is not the merchant's to edit (or a change to save).
  const [variantPrices, setVariantPrices] = React.useState<VariantPriceRange | null>(null);
  // The Inventory card and the Shipping card's weight: drawn there by the variant editor.
  const [inventorySlot, setInventorySlot] = React.useState<HTMLDivElement | null>(null);
  const [shippingSlot, setShippingSlot] = React.useState<HTMLDivElement | null>(null);
  const slots = React.useMemo<ProductEditorSlots>(() => ({ inventory: inventorySlot, shipping: shippingSlot }), [inventorySlot, shippingSlot]);
  React.useEffect(() => {
    form.resetField("variantPriced", { defaultValue: variantPrices !== null });
    if (variantPrices) form.resetField("price", { defaultValue: variantPrices.min });
  }, [form, variantPrices]);

  /** One line per field that failed the page's own checks, for the save banner; a fixed field's line comes off. */
  const invalidLines = useFieldErrorLines(form);

  const save = async () => {
    if (latestReadOnly.current) throw new SaveNotCompleted(r("readOnly"));
    if (revisionConflict) {
      onOpenRevisionConflict?.();
      throw new SaveNotCompleted(t("changedElsewhere"));
    }
    // New products send their variants with the product, so their problems block the save too.
    const matrixBlocks = optionMatrixIssue && (!isEdit || optionMatrixDirty);
    const pending = isEdit ? sections.dirtyHandles() : [];
    const sectionProblems = pending.flatMap((handle) => handle.problems ?? []);
    // A Save is one write of the whole page (fields, variants, sections, costs): every part
    // is checked first, and all of it saves or none of it does.
    let fieldLines: string[] = [];
    let fieldFocus: Record<string, () => void> = {};
    let values = await new Promise<ProductFormValues | null>((resolve) => {
      void form.handleSubmit(resolve, (errors) => {
        fieldLines = invalidLines(errors, (field) => {
          const message = errors[field]?.message;
          return problemLine(productFieldLabel(field), typeof message === "string" ? message : s("fixErrors"));
        });
        // Each line is a link to its field.
        fieldFocus = Object.fromEntries(
          Object.keys(errors).map((field, index) => [fieldLines[index]!, () => form.setFocus(field as keyof ProductFormValues)]),
        );
        resolve(null);
      })();
    });
    if (!values || matrixBlocks || sectionProblems.length > 0) {
      if (matrixBlocks) matrixRef.current?.reveal();
      const lines = [...fieldLines, ...(matrixBlocks ? [optionMatrixIssue] : []), ...sectionProblems];
      throw new SaveNotCompleted(lines[0], lines, fieldFocus);
    }
    const composition = isEdit && optionMatrixDirty ? matrixRef.current?.composition() ?? null : null;
    const sectionChanges = Object.assign({}, ...pending.map((handle) => handle.changes()));
    // Moved tabs become blocks in this write, which also removes the originals.
    if (tabsMoved.current) {
      form.setValue("additionalInfo", [], { shouldDirty: true });
      values = { ...values, additionalInfo: [] };
    }
    if (latestReadOnly.current) throw new SaveNotCompleted(r("readOnly"));
    await submit(values, aggregateRevision, { ...composition, ...sectionChanges });
    for (const handle of pending) handle.saved();
    if (tabsMoved.current) {
      tabsMoved.current = false;
      void queryClient.invalidateQueries({ queryKey: [...queryKeys.products.detail(productId ?? ""), "section"] });
    }
  };

  useSaveBar({
    dirty: !readOnly && (productFormDirty || optionMatrixDirty || sections.dirty || revisionConflict !== null),
    navigationDirty: productFormDirty || optionMatrixNavigationDirty || sections.navigationDirty || revisionConflict !== null,
    saving: isSubmitting || optionMatrixSaving,
    save,
    discard: () => {
      if (revisionConflict) onOpenRevisionConflict?.();
      else onDiscard();
    },
  });
  const scope = useSaveScope();

  // New products show the web address the server will make from the title until it is edited;
  // an address the merchant didn't type is never sent (see formatFormValuesForSubmission).
  React.useEffect(() => {
    if (isEdit) return;
    const subscription = form.watch((value, { name }) => {
      if (name === "name" && !form.getValues("slugEdited")) {
        // Re-check only to clear an existing error; never flag the address while the title is typed.
        form.setValue("slug", autoHandleFor(value.name ?? "", "product"), { shouldValidate: Boolean(form.getFieldState("slug").error) });
      }
    });
    return () => subscription.unsubscribe();
  }, [form, isEdit]);

  const affectedCount = mediaRemovalConflict?.affectedCount ?? 0;
  const productId = defaultValues?.id;
  const productName = defaultValues?.name ?? "";
  const appActions = useAppActionRunner("product", false);
  const translateItem = useTranslateMenuItem("product", isEdit ? productId : undefined);

  const moreActions = isEdit && productId ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" loading={appActions.pending !== null}>
          {r("moreActions")}
          <ChevronDown className="ms-1 h-4 w-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {can.canCreate ? (
          <DropdownMenuItem disabled={duplicate.isPending} onSelect={() => duplicate.mutate({ id: productId, name: productName })}>
            {t("duplicate")}
          </DropdownMenuItem>
        ) : null}
        {translateItem}
        {variantIds.length > 0 ? (
          <DropdownMenuItem asChild>
            <Link to="/admin/inventory/labels" search={{ variants: variantIds.join(",") }}>{t("printLabels")}</Link>
          </DropdownMenuItem>
        ) : null}
        {/* Apps' actions for this product (apps.use). */}
        {appActions.entries.map((entry) => (
          <DropdownMenuItem
            key={appActionKey(entry)}
            variant={entry.action.destructive ? "destructive" : undefined}
            onSelect={() => appActions.start(entry, [productId])}
          >
            {entry.action.label}
          </DropdownMenuItem>
        ))}
        {can.canDelete ? (
          <DropdownMenuItem variant="destructive" onSelect={() => setTrashOpen(true)}>{r("moveToTrash")}</DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  return (
    <Page width="form">
      <PageHeader
        title={isEdit ? defaultValues?.name : t("addProduct")}
        backTo="/admin/products"
        status={isEdit ? <ProductStatusBadge isActive={Boolean(defaultValues?.isActive)} /> : null}
        presence={isEdit ? presence?.(productFormDirty || optionMatrixDirty || sections.dirty, readOnly) : null}
        actions={isEdit && productId ? (
          <>
            {moreActions}
            <ProductPager productId={productId} />
          </>
        ) : null}
      />
      {readOnly ? <ReadOnlyNotice /> : null}
      <Form {...form}>
        <form
          method="post"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            // React bubbles submits from forms in portalled dialogs; only this form saves the page.
            if (readOnly || event.target !== event.currentTarget || scope?.busy) return;
            if (scope?.dirty) void scope.saveAll();
            // A new product can be saved before anything is typed: say what it needs, as Shopify does.
            else if (!isEdit) void form.trigger(undefined, { shouldFocus: true });
          }}
          className="flex flex-col gap-4 pb-6"
        >
          <SaveErrorBanner />
          <ProductKindRulesProvider form={form}>
          <ProductSectionsProvider registry={sections.registry}>
          <ProductEditorSlotsContext.Provider value={slots}>
          {/* Shopify's product page: what every product needs in the main column, in its order
              (title, media, pricing, inventory, shipping, variants), then the advanced cards, each
              always listed by title and closed while empty. The side column holds status,
              organisation and the page template. */}
          <div className="grid min-w-0 gap-4 lg:grid-cols-3">
            <div className="min-w-0 space-y-4 lg:col-span-2">
              <fieldset disabled={readOnly} className="min-w-0 space-y-4">
              <TitleDescriptionSection form={form} readOnly={readOnly} />
              </fieldset>
              <ProductImagesSection form={form} readOnly={readOnly} />
              <fieldset disabled={readOnly} className="min-w-0 space-y-4">
              <PricingCard form={form} variantPrices={variantPrices} readOnly={readOnly} />
              <div ref={setInventorySlot} className="empty:hidden" />
              <ShippingCard form={form} hasOptions={variantPrices !== null} weightSlot={setShippingSlot} readOnly={readOnly} />
              </fieldset>
              <Card id="product-variants" className="scroll-mt-4">
                <CardHeader>
                  <CardTitle>{t("variants")}</CardTitle>
                </CardHeader>
                <CardContent
                  onKeyDownCapture={(event) => {
                    // Enter inside the variant table must not submit the product form.
                    if (
                      event.key === "Enter" &&
                      event.target instanceof HTMLElement &&
                      (!readOnly || event.target instanceof HTMLInputElement) &&
                      event.target.closest("[data-variant-editor]") &&
                      !event.target.closest("[data-option-value-composer]")
                    ) {
                      event.preventDefault();
                    }
                  }}
                >
                  <ProductVariants form={form} optionManager={optionManager} onPricesChange={setVariantPrices} readOnly={readOnly} />
                </CardContent>
              </Card>
              <DigitalDeliveryCard form={form} productId={productId} readOnly={readOnly} />
              <GiftCardProductCard form={form} productId={productId} readOnly={readOnly} />
              {isEdit && productId ? (
                <React.Suspense fallback={<LoadingFallback height="h-20" />}>
                  <BundlesCard productId={productId} readOnly={readOnly} />
                </React.Suspense>
              ) : (
                <AfterSaveCard title={t("bundles")} />
              )}
              <React.Suspense fallback={<LoadingFallback height="h-20" />}>
                <BuyerInputsCard
                  form={form}
                  readOnly={readOnly}
                  savedInvalid={customizationSchemaInvalid}
                  conflict={revisionConflict && dirtyFields.customizationSchema && onOpenRevisionConflict
                    ? { onReview: onOpenRevisionConflict }
                    : null}
                />
              </React.Suspense>
              {isEdit && productId ? (
                <React.Suspense fallback={<LoadingFallback height="h-20" />}>
                  <ContentBlocksCard productId={productId} readOnly={readOnly} onTabsMoved={() => { tabsMoved.current = true; }} />
                </React.Suspense>
              ) : (
                // A new product's tabs go with it; once saved they are edited as content blocks.
                <AdditionalSectionsCard form={form} readOnly={readOnly} />
              )}
              <AttributesSection form={form} defaultOpen={readOnly} readOnly={readOnly} />
              <fieldset disabled={readOnly} className="min-w-0"><ProductSearchListing form={form} disabled={readOnly} /></fieldset>
            </div>
            {/* On phones the status comes first; the rest of the side column follows the main cards. */}
            <div className="min-w-0 space-y-4 max-lg:contents">
              <fieldset disabled={readOnly} className="min-w-0 max-lg:order-first">
                <ProductStatusCard form={form} isEdit={isEdit} getStorefrontPath={getStorefrontPath} readOnly={readOnly} />
              </fieldset>
              <fieldset disabled={readOnly} className="min-w-0 space-y-4">
              <PublishingCard form={form} readOnly={readOnly} />
              <OrganizationCard form={form} categories={categories} brandName={brandName} readOnly={readOnly} />
              </fieldset>
              {isEdit && productId ? (
                <React.Suspense fallback={<LoadingFallback height="h-40" />}>
                  <ProductPageCard productId={productId} readOnly={readOnly} />
                </React.Suspense>
              ) : (
                <AfterSaveCard title={t("productPage")} />
              )}
              <fieldset disabled={readOnly} className="min-w-0 space-y-4">
              <WarrantyCard form={form} readOnly={readOnly} />
              {isEdit && productId ? <LazyCustomFieldsCard ownerType="product" ownerId={productId} canEdit={!readOnly} /> : null}
              {isEdit && productId ? <RelatedObjectsCard records={relatedObjects} /> : null}
              {isEdit && productId ? <AppResourceCards target="product" id={productId} /> : null}
              </fieldset>
            </div>
          </div>
          </ProductEditorSlotsContext.Provider>
          </ProductSectionsProvider>
          </ProductKindRulesProvider>
        </form>
      </Form>
      <AlertDialog
        open={mediaRemovalConflict !== null}
        onOpenChange={(open) => { if (!open) cancelMediaRemoval(); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeVariantPhotosTitle", { count: affectedCount })}</AlertDialogTitle>
            <AlertDialogDescription>{t("removeVariantPhotosBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          {mediaRemovalConflict?.affectedSkus.length ? (
            <ul className="max-h-40 space-y-1 overflow-y-auto text-body">
              {mediaRemovalConflict.affectedSkus.map((sku) => (
                <li key={sku.id} className="truncate">{sku.sku}</li>
              ))}
              {affectedCount > mediaRemovalConflict.affectedSkus.length ? (
                <li className="text-muted-foreground">
                  {t("andMore", { count: affectedCount - mediaRemovalConflict.affectedSkus.length })}
                </li>
              ) : null}
            </ul>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelMediaRemoval}>{t("keepPhotos")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={isSubmitting}
              variant="destructive"
              onClick={(event) => {
                event.preventDefault();
                void confirmMediaRemoval();
              }}
            >
              {t("removePhotos")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ConfirmDialog
        open={trashOpen}
        onOpenChange={setTrashOpen}
        title={t("trashProductTitle", { name: productName })}
        description={t("trashProductBody")}
        confirmLabel={r("moveToTrash")}
        cancelLabel={r("cancel")}
        loadingLabel={r("working")}
        variant="default"
        isLoading={trash.isPending}
        onConfirm={() => {
          if (productId && aggregateRevision) trash.mutate({ id: productId, expectedAggregateRevision: aggregateRevision });
        }}
      />
      {appActions.dialogs}
    </Page>
  );
}

/**
 * Which editor sections apply to this kind of product (a gift card hides
 * shipping, discounts and inventory). Only the gift-card switch or the
 * fulfilment kind re-renders it, and then only the cards that read the rules.
 */
function ProductKindRulesProvider({ form, children }: {
  form: UseFormReturn<ProductFormValues>;
  children: React.ReactNode;
}) {
  const [isGiftCard, fulfillmentKind] = useWatch({ control: form.control, name: ["isGiftCard", "fulfillmentKind"] });
  const rules = React.useMemo(() => productKindRules({ isGiftCard, fulfillmentKind }), [isGiftCard, fulfillmentKind]);
  return <ProductKindRulesContext.Provider value={rules}>{children}</ProductKindRulesContext.Provider>;
}

// The editor's root must not re-render while the merchant types: these two
// read the fields they show with useWatch, so a keystroke in the title
// re-renders them, not the whole page.

function ProductStatusCard({ form, isEdit, getStorefrontPath, readOnly }: {
  form: UseFormReturn<ProductFormValues>;
  isEdit: boolean;
  getStorefrontPath: (path: string) => string;
  readOnly: boolean;
}) {
  const slug = useWatch({ control: form.control, name: "slug" });
  return (
    <StatusCard
      form={form}
      readOnly={readOnly}
      storefrontUrl={isEdit && slug ? getStorefrontPath(`/products/${slug}`) : undefined}
    />
  );
}

function ProductVariants({ form, optionManager, onPricesChange, readOnly }: {
  readOnly: boolean;
  form: UseFormReturn<ProductFormValues>;
  optionManager: ProductFormProps["optionManager"];
  onPricesChange: (range: VariantPriceRange | null) => void;
}) {
  const [media, name, price, isActive, fulfilmentMode] = useWatch({
    control: form.control,
    name: ["media", "name", "price", "isActive", "fulfillmentKind"],
  });
  const skuImages = React.useMemo(() => (media ?? [])
    .filter((item) => item.kind === "image")
    .map((item) => ({
      id: item.id,
      url: item.url,
      altText: item.effectiveAltText,
      isPrimary: item.isPrimary,
      sortOrder: item.sortOrder,
      status: item.status,
    })), [media]);
  // The title and price only seed unsaved variants' SKUs and prices: the
  // variant table catches up after the keystroke has painted.
  const productName = React.useDeferredValue(name ?? "");
  const productPrice = React.useDeferredValue(Number.isFinite(price) ? price ?? 0 : 0);
  const mode = fulfilmentMode ?? "physical";
  return React.useMemo(
    () => optionManager({ readOnly, skuImages, productName, productPrice, isActive: Boolean(isActive), onPricesChange, fulfilmentMode: mode }),
    [readOnly, optionManager, skuImages, productName, productPrice, isActive, onPricesChange, mode],
  );
}

/** An advanced card a new product gets once it is saved: listed by title, so it is never a surprise. */
function AfterSaveCard({ title }: { title: string }) {
  const t = useMessages(productMessages);
  const note = <p className="text-body text-muted-foreground">{t("availableAfterSave")}</p>;
  return (
    <CollapsibleCard title={title} summary={note}>
      {note}
    </CollapsibleCard>
  );
}
