import React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useFormState, useWatch } from "react-hook-form";
import type { UseFormReturn } from "react-hook-form";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  postApiV1AdminCollections,
  putApiV1AdminCollectionsById,
} from "@scalius/api-client/sdk";
import { FormContainer } from "~/components/admin/shared/FormContainer";
import { SaveConflict, SaveNotCompleted } from "~/components/admin/shared/SaveBar";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { SearchListingCard } from "~/components/admin/search-listing/SearchListingCard";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { useMessages } from "~/i18n";
import { catalogMessages } from "~/i18n/catalog";
import { collectionFormMessages } from "~/i18n/collection-form";
import { resourceMessages } from "~/i18n/resource";
import { apiData } from "~/lib/api";
import { getPlainText } from "~/lib/format-utils";
import { queryKeys } from "~/lib/query-keys";
import { CollectionContentSection } from "./CollectionContentSection";
import { LayoutSettingsSection } from "./LayoutSettingsSection";
import { ProductSelectionSection } from "./ProductSelectionSection";
import {
  collectionFormSchema,
  MAX_MEMBERSHIP_IDS,
  type CollectionFormInput,
  type CollectionFormProps,
  type CollectionFormValues,
  type Product,
} from "./types";

type CollectionFormApi = UseFormReturn<CollectionFormInput, unknown, CollectionFormValues>;

const DEFAULT_CONFIG = {
  source: "manual" as const,
  categoryIds: [] as string[],
  productIds: [] as string[],
  showOnHomepage: false,
  maxProducts: 8,
  title: "",
  subtitle: "",
} as const;

const EMPTY_PRODUCTS: Product[] = [];

/** The shared search engine listing card, bound to the collection's search fields. */
function CollectionSearchListing({ form, disabled }: { form: CollectionFormApi; disabled: boolean }) {
  const [id, name, description, canonicalPath, metaTitle, metaDescription, noIndex] = useWatch({
    control: form.control,
    name: ["id", "name", "description", "canonicalPath", "metaTitle", "metaDescription", "noIndex"],
  });
  const { errors } = useFormState({ control: form.control, name: ["metaTitle", "metaDescription"] });
  const edit = { shouldDirty: true, shouldValidate: true } as const;
  return (
    <SearchListingCard
      resource="collection"
      path={canonicalPath || (id ? `/collections/${id}` : null)}
      value={{ title: metaTitle ?? "", description: metaDescription ?? "", hidden: noIndex === true }}
      onChange={(next) => {
        if (next.title !== undefined) form.setValue("metaTitle", next.title || null, edit);
        if (next.description !== undefined) form.setValue("metaDescription", next.description || null, edit);
        if (next.hidden !== undefined) form.setValue("noIndex", next.hidden, edit);
      }}
      fallbackTitle={name}
      fallbackDescription={getPlainText(description ?? null, 320)}
      errors={{ title: errors.metaTitle?.message, description: errors.metaDescription?.message }}
      disabled={disabled}
    />
  );
}

/**
 * The collection editor. Main column: title and description, products,
 * search engine listing. Side column: status and homepage.
 */
export function CollectionForm({
  categories,
  products = EMPTY_PRODUCTS,
  defaultValues,
  isEdit = false,
}: CollectionFormProps) {
  const navigate = useNavigate();
  const t = useMessages(catalogMessages);
  const tf = useMessages(collectionFormMessages);
  const tr = useMessages(resourceMessages);
  const queryClient = useQueryClient();
  const { collections: collectionActions } = useCatalogActionPermissions();
  const canSave = isEdit ? collectionActions.canEdit : collectionActions.canCreate;
  const [knownProducts, setKnownProducts] = React.useState<Product[]>(products);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const form = useForm<CollectionFormInput, unknown, CollectionFormValues>({
    resolver: zodResolver(collectionFormSchema),
    defaultValues: {
      name: "",
      description: null,
      content: null,
      presentation: "grid",
      isActive: false,
      canonicalPath: null,
      noIndex: false,
      excludeFromSitemap: false,
      metaTitle: null,
      metaDescription: null,
      config: { ...DEFAULT_CONFIG },
      ...defaultValues,
    },
  });

  const [selectedSource, selectedCategoryIds, selectedProductIds] = useWatch({
    control: form.control,
    name: ["config.source", "config.categoryIds", "config.productIds"],
  });

  const rememberProducts = React.useCallback((incoming: Product[]) => {
    setKnownProducts((current) => {
      const byId = new Map(current.map((product) => [product.id, product]));
      for (const product of incoming) byId.set(product.id, product);
      return Array.from(byId.values());
    });
  }, []);
  const rememberProduct = React.useCallback((product: Product) => rememberProducts([product]), [rememberProducts]);

  React.useEffect(() => rememberProducts(products), [products, rememberProducts]);

  const loadingName = tf("loadingName");
  const selectedProducts = React.useMemo(() => {
    const byId = new Map(knownProducts.map((product) => [product.id, product]));
    return selectedProductIds.map((id) => byId.get(id) ?? { id, name: loadingName });
  }, [knownProducts, selectedProductIds, loadingName]);

  const saveCollection = async (values: CollectionFormValues) => {
    if (
      values.isActive &&
      values.config.source === "dynamic" &&
      categories.some((category) =>
        values.config.categoryIds.includes(category.id) &&
        category.status !== "published")
    ) {
      form.setError("config.categoryIds", { type: "validate", message: tf("publishCategories") });
      throw new SaveNotCompleted(tf("publishCategories"));
    }
    setIsSubmitting(true);
    try {
      const submission = {
        ...values,
        config: {
          ...values.config,
          featuredProductId: values.config.featuredProductId || "",
        },
      };
      let savedCollectionId: string;
      let saved: { id: string; version: number };
      if (isEdit) {
        const entityId = defaultValues?.id || values.id;
        const expectedVersion = values.version || defaultValues?.version;
        if (!entityId || !expectedVersion) throw new SaveNotCompleted(tr("saveFailedHelp"));
        const result = await apiData(putApiV1AdminCollectionsById({
          path: { id: entityId },
          body: { ...submission, expectedVersion },
        })).catch((error: unknown) => {
          if (error instanceof AdminApiResponseError && error.code === "COLLECTION_REVISION_CONFLICT") throw new SaveConflict();
          throw error;
        });
        saved = { id: result.id, version: result.version };
        savedCollectionId = entityId;
      } else {
        const result = await apiData(postApiV1AdminCollections({ body: submission }));
        saved = { id: result.id, version: result.version };
        savedCollectionId = result.id;
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.collections.list() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.collections.byIds() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.collections.formOptions() }),
        ...(isEdit
          ? [queryClient.invalidateQueries({ queryKey: queryKeys.collections.detail(savedCollectionId) })]
          : []),
      ]);

      if (!isEdit) {
        void navigate({
          to: "/admin/collections/$collectionId/edit",
          params: { collectionId: savedCollectionId },
          replace: true,
        });
      }
      return saved;
    } finally {
      setIsSubmitting(false);
    }
  };

  const setIds = React.useCallback(
    (name: "config.categoryIds" | "config.productIds", ids: string[]) =>
      form.setValue(name, ids, { shouldDirty: true, shouldValidate: true }),
    [form],
  );

  const addCategory = React.useCallback((categoryId: string) => {
    const current = form.getValues("config.categoryIds");
    if (current.length < MAX_MEMBERSHIP_IDS && !current.includes(categoryId)) {
      setIds("config.categoryIds", [...current, categoryId]);
    }
  }, [form, setIds]);

  const removeCategory = React.useCallback((categoryId: string) => {
    setIds("config.categoryIds", form.getValues("config.categoryIds").filter((id) => id !== categoryId));
  }, [form, setIds]);

  const addProducts = React.useCallback((newProducts: Product[]) => {
    rememberProducts(newProducts);
    const current = form.getValues("config.productIds");
    const next = [...current];
    for (const product of newProducts) {
      if (next.length < MAX_MEMBERSHIP_IDS && !next.includes(product.id)) next.push(product.id);
    }
    if (next.length !== current.length) setIds("config.productIds", next);
  }, [form, rememberProducts, setIds]);

  const removeProduct = React.useCallback((productId: string) => {
    setIds("config.productIds", form.getValues("config.productIds").filter((id) => id !== productId));
  }, [form, setIds]);

  const moveProduct = React.useCallback((productId: string, direction: -1 | 1) => {
    const current = form.getValues("config.productIds");
    const from = current.indexOf(productId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= current.length) return;
    const reordered = [...current];
    [reordered[from], reordered[to]] = [reordered[to]!, reordered[from]!];
    setIds("config.productIds", reordered);
  }, [form, setIds]);

  return (
    <FormContainer
      heading={isEdit ? defaultValues?.name || t("collection") : t("addCollection")}
      isSubmitting={isSubmitting}
      backUrl="/admin/collections"
      canSave={canSave}
      form={form}
      onSave={saveCollection}
      savedValues={(result) => result as Partial<CollectionFormInput>}
      unsavedLabel={isEdit ? undefined : tf("unsavedCollection")}
      savedMessage={tf("saved")}
    >
      <div className="grid min-w-0 gap-4 lg:grid-cols-3 lg:items-start">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <CollectionContentSection form={form} readOnly={!canSave} />
          <ProductSelectionSection
            form={form}
            selectedSource={selectedSource}
            categories={categories}
            selectedProducts={selectedProducts}
            selectedCategoryIds={selectedCategoryIds}
            selectedProductIds={selectedProductIds}
            addCategory={addCategory}
            removeCategory={removeCategory}
            addProducts={addProducts}
            removeProduct={removeProduct}
            moveProduct={moveProduct}
          />
          <CollectionSearchListing form={form} disabled={!canSave} />
        </div>
        <LayoutSettingsSection
          form={form}
          knownProducts={knownProducts}
          selectedCategoryIds={selectedSource === "dynamic" ? selectedCategoryIds : []}
          onProductDiscovered={rememberProduct}
        />
      </div>
    </FormContainer>
  );
}
