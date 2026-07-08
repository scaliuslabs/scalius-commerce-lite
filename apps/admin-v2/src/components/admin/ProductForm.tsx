import React from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Form } from "../ui/form";
import { UnsavedChangesGuard } from "./shared/UnsavedChangesGuard";
import { ProductActionBar } from "./product-form/ProductStickyHeader";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { useStorefrontUrl } from "@/hooks/use-storefront-url";
import {
  registerAdminAssistantPageActionHandler,
  type AdminAssistantPageAction,
} from "./assistant/page-actions";
import { registerAdminAssistantSurface } from "./assistant/page-state";
import {
  ProductImagesSection,
  TitleDescriptionSection,
  SeoSection,
  OptionDiscoverySection,
  AttributesSection,
  PricingCard,
  StatusCard,
  OrganizationCard,
  InfoBanner,
  useProductSubmit,
  useProductVariants,
  productFormSchema,
  cleanMetaDescription,
  hasVariantImagesEnabled,
  getVariantImagesAxis,
  resolveVariantImageAxis,
  generateSlug,
  DEFAULT_PRODUCT_OPTION_LABELS,
  DEFAULT_PRODUCT_OPTION_SCHEMA,
  DEFAULT_PRODUCT_CONDITION,
  type ProductFormValues,
  type Category,
} from "./product-form";
import {
  buildProductAssistantSurfaceLabel,
  createProductAssistantActionHandlers,
  createProductAssistantSurfaceActions,
  countProductAssistantValidationErrors,
  focusProductAssistantFieldInForm,
  getProductAssistantActionId,
  PRODUCT_ASSISTANT_SURFACE_CAPABILITIES,
  type ProductAssistantField,
  type ProductAssistantSurfaceRegistration,
} from "./product-form/assistantSurface";
import type { VariantOptionLabels } from "./product-form/variants/types";

interface ProductFormProps {
  categories: Category[];
  defaultValues?: Partial<
    ProductFormValues & { attributes?: Array<{ attributeId: string; value: string }>; additionalInfo?: Array<{ id: string; title: string; content: string }> }
  >;
  isEdit?: boolean;
}

export function ProductForm({
  categories,
  defaultValues,
  isEdit = false,
}: ProductFormProps) {
  const { storefrontUrl, getStorefrontPath } = useStorefrontUrl();

  // Clean the meta description to avoid showing the marker to users
  const cleanedDefaultValues = React.useMemo(() => {
    if (!defaultValues) return undefined;

    return {
      ...defaultValues,
      metaDescription: cleanMetaDescription(defaultValues.metaDescription),
    };
  }, [defaultValues]);

  // Handle variant specific images independently from form schema
  const [enableVariantImages, setEnableVariantImages] = React.useState(
    hasVariantImagesEnabled(defaultValues?.metaDescription) || false,
  );
  const [variantImageAxis, setVariantImageAxis] = React.useState(
    getVariantImagesAxis(defaultValues?.metaDescription),
  );

  const {
    variants,
    uniqueOptionOneValues,
    uniqueOptionTwoValues,
    isLoading: variantsLoading,
  } = useProductVariants({
    productId: defaultValues?.id,
    isEdit,
  });
  const effectiveVariantImageAxis = React.useMemo(
    () =>
      resolveVariantImageAxis(
        variantImageAxis,
        uniqueOptionOneValues,
        uniqueOptionTwoValues,
      ),
    [uniqueOptionOneValues, uniqueOptionTwoValues, variantImageAxis],
  );

  React.useEffect(() => {
    if (effectiveVariantImageAxis !== variantImageAxis) {
      setVariantImageAxis(effectiveVariantImageAxis);
    }
  }, [effectiveVariantImageAxis, variantImageAxis]);

  // Initialize form
  const form = useForm<ProductFormValues>({
    resolver: zodResolver(productFormSchema),
    defaultValues: {
      name: "",
      description: null,
      price: 0,
      categoryId: "",
      isActive: true,
      discountType: "percentage",
      discountPercentage: 0,
      discountAmount: 0,
      freeDelivery: false,
      metaTitle: null,
      metaDescription: null,
      noIndex: false,
      excludeFromSitemap: false,
      excludeFromProductFeed: false,
      productCondition: DEFAULT_PRODUCT_CONDITION,
      variantOption1Label: DEFAULT_PRODUCT_OPTION_LABELS.option1,
      variantOption2Label: DEFAULT_PRODUCT_OPTION_LABELS.option2,
      variantOption1Schema: DEFAULT_PRODUCT_OPTION_SCHEMA.option1,
      variantOption2Schema: DEFAULT_PRODUCT_OPTION_SCHEMA.option2,
      slug: "",
      images: [],
      slugEdited: false,
      attributes: [],
      additionalInfo: [],
      ...cleanedDefaultValues,
    },
  });

  const variantOption1Label = form.watch("variantOption1Label");
  const variantOption2Label = form.watch("variantOption2Label");
  const variantOptionLabels = React.useMemo<VariantOptionLabels>(
    () => ({
      option1:
        variantOption1Label?.trim() || DEFAULT_PRODUCT_OPTION_LABELS.option1,
      option2:
        variantOption2Label?.trim() || DEFAULT_PRODUCT_OPTION_LABELS.option2,
    }),
    [variantOption1Label, variantOption2Label],
  );

  // Set up form submission handler
  const { isSubmitting, showAlert, alertMessage, setShowAlert, handleSubmit } =
    useProductSubmit({
      isEdit,
      productId: defaultValues?.id,
      enableVariantImages,
      variantImageAxis: effectiveVariantImageAxis,
      form,
    });

  // Assistant context is allowlisted product drafting state only; never widen to raw form values.
  const assistantFormRef = React.useRef<HTMLFormElement | null>(null);
  const assistantSkipSlugGenerationRef = React.useRef(false);
  const assistantIsSubmittingRef = React.useRef(isSubmitting);
  const assistantValidationErrorCountRef = React.useRef(0);
  const assistantSubmitHandlerRef = React.useRef(handleSubmit);
  const assistantSurfaceId = isEdit
    ? "product-edit-form"
    : "product-create-form";
  const assistantName = form.watch("name");
  const assistantDescription = form.watch("description");
  const assistantValidationErrorCount = countProductAssistantValidationErrors(
    form.formState.errors,
  );
  const assistantSurfaceLabel = React.useMemo(
    () =>
      buildProductAssistantSurfaceLabel({
        mode: isEdit ? "edit" : "create",
        name: assistantName,
        description: assistantDescription,
      }),
    [assistantDescription, assistantName, isEdit],
  );
  React.useEffect(() => {
    assistantIsSubmittingRef.current = isSubmitting;
    assistantValidationErrorCountRef.current = assistantValidationErrorCount;
    assistantSubmitHandlerRef.current = handleSubmit;
  }, [assistantValidationErrorCount, handleSubmit, isSubmitting]);

  const focusAssistantField = React.useCallback(
    (field: ProductAssistantField) =>
      focusProductAssistantFieldInForm(assistantFormRef.current, field),
    [],
  );
  const applyAssistantFieldDraft = React.useCallback(
    (field: ProductAssistantField, value: string) => {
      if (field === "name") {
        assistantSkipSlugGenerationRef.current = true;
      }

      form.setValue(field, value, {
        shouldDirty: true,
        shouldTouch: true,
        shouldValidate: true,
      });
      void form.trigger(field);

      if (field === "name") {
        queueMicrotask(() => {
          assistantSkipSlugGenerationRef.current = false;
        });
      }
    },
    [form],
  );
  const saveAssistantRegisteredForm = React.useCallback(async () => {
    if (assistantIsSubmittingRef.current) return false;

    const isValid = await form.trigger();
    if (!isValid) return false;

    await form.handleSubmit((values) =>
      assistantSubmitHandlerRef.current(values),
    )();
    return true;
  }, [form]);
  const assistantPageActions = React.useMemo(
    () =>
      createProductAssistantActionHandlers({
        focusField: focusAssistantField,
        applyFieldDraft: applyAssistantFieldDraft,
        saveForm: saveAssistantRegisteredForm,
        isSubmitting: () => assistantIsSubmittingRef.current,
        validateForm: () => form.trigger(),
        getValidationErrorCount: () =>
          assistantValidationErrorCountRef.current,
      }),
    [
      applyAssistantFieldDraft,
      focusAssistantField,
      form,
      saveAssistantRegisteredForm,
    ],
  );
  const assistantSurfaceActions = React.useMemo(
    () => createProductAssistantSurfaceActions(assistantSurfaceId),
    [assistantSurfaceId],
  );
  const assistantSurfaceHandleRef = React.useRef<ReturnType<
    typeof registerAdminAssistantSurface
  > | null>(null);

  React.useEffect(() => {
    const handles = PRODUCT_ASSISTANT_SURFACE_CAPABILITIES.actions.map(
      (actionName) =>
        registerAdminAssistantPageActionHandler(
          getProductAssistantActionId(assistantSurfaceId, actionName),
          async (action: AdminAssistantPageAction) => {
            if (
              action.targetId !== assistantSurfaceId ||
              action.type !== actionName
            ) {
              return false;
            }

            if (actionName === "focus_surface") {
              const result = await assistantPageActions.focus_surface({
                fieldName:
                  action.type === "focus_surface"
                    ? action.fieldName
                    : undefined,
              });
              return result.ok;
            }

            if (actionName === "apply_field_draft") {
              if (action.type !== "apply_field_draft") return false;
              const result = await assistantPageActions.apply_field_draft({
                fieldName: action.fieldName,
                value:
                  typeof action.value === "string" ? action.value : undefined,
              });
              return result.ok;
            }

            const result = await assistantPageActions.save_registered_form();
            return result.ok;
          },
        ),
    );

    return () => {
      handles.forEach((handle) => handle.unregister());
    };
  }, [assistantPageActions, assistantSurfaceId]);

  React.useEffect(() => {
    const registration: ProductAssistantSurfaceRegistration = {
      id: assistantSurfaceId,
      kind: "form",
      assistantCapabilities: PRODUCT_ASSISTANT_SURFACE_CAPABILITIES,
      assistantActions: assistantSurfaceActions,
    };
    const handle = registerAdminAssistantSurface(registration);
    assistantSurfaceHandleRef.current = handle;

    return () => {
      handle.unregister();
      if (assistantSurfaceHandleRef.current === handle) {
        assistantSurfaceHandleRef.current = null;
      }
    };
  }, [assistantSurfaceActions, assistantSurfaceId]);

  React.useEffect(() => {
    const update: Partial<ProductAssistantSurfaceRegistration> = {
      id: assistantSurfaceId,
      label: assistantSurfaceLabel,
      dirty: form.formState.isDirty,
      submitting: isSubmitting,
      validationErrorCount: assistantValidationErrorCount,
      assistantCapabilities: PRODUCT_ASSISTANT_SURFACE_CAPABILITIES,
      assistantActions: assistantSurfaceActions,
    };
    assistantSurfaceHandleRef.current?.update(update);
  }, [
    assistantSurfaceActions,
    assistantSurfaceId,
    assistantSurfaceLabel,
    assistantValidationErrorCount,
    form.formState.isDirty,
    isSubmitting,
  ]);

  // Auto-generate slug from name - ONLY for new products
  React.useEffect(() => {
    if (!isEdit) {
      const subscription = form.watch((value, { name }) => {
        if (
          name === "name" &&
          value.name &&
          !form.getValues("slugEdited") &&
          !assistantSkipSlugGenerationRef.current
        ) {
          const slug = generateSlug(value.name);
          form.setValue("slug", slug, {
            shouldValidate: true,
          });
        }
      });
      return () => subscription.unsubscribe();
    }
  }, [form, isEdit]);

  return (
    <ErrorBoundary fallback={<div className="p-4 text-center text-muted-foreground">Something went wrong loading the product form. <button onClick={() => window.location.reload()} className="underline">Reload</button></div>}>
    <>
      <UnsavedChangesGuard
        isDirty={form.formState.isDirty}
        isSubmitting={isSubmitting}
      />
      <Form {...form}>
        <form
          ref={assistantFormRef}
          method="post"
          onSubmit={form.handleSubmit(handleSubmit)}
          className="-mt-4 pb-6"
          noValidate
        >
          {/* Two-Column Layout */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-5">
            {/* Left Column - Main Content (2/3 width on large screens) */}
            <div className="lg:col-span-2 space-y-4">
              {/* Title & Description */}
              <TitleDescriptionSection form={form} />

              {/* Product Images */}
              <ProductImagesSection
                form={form}
                enableVariantImages={enableVariantImages}
                setEnableVariantImages={setEnableVariantImages}
                variantImageAxis={effectiveVariantImageAxis}
                setVariantImageAxis={setVariantImageAxis}
                uniqueOptionOneValues={uniqueOptionOneValues}
                uniqueOptionTwoValues={uniqueOptionTwoValues}
                optionLabels={variantOptionLabels}
              />
            </div>

            {/* Right Column - Settings & Metadata (1/3 width on large screens) */}
            <div className="space-y-3">
              {/* Status */}
              <StatusCard
                form={form}
                isEdit={isEdit}
                storefrontUrl={
                  isEdit && form.watch("slug")
                    ? getStorefrontPath(`/products/${form.watch("slug")}`)
                    : undefined
                }
              />

              {/* Organization */}
              <OrganizationCard
                form={form}
                categories={categories}
                isEdit={isEdit}
              />

              {/* Pricing */}
              <PricingCard form={form} />

              {/* SEO */}
              <SeoSection
                form={form}
                variants={variants}
                variantState={
                  isEdit ? (variantsLoading ? "loading" : "loaded") : "unavailable"
                }
                storefrontUrl={storefrontUrl}
              />

              {/* Catalog option mapping */}
              <OptionDiscoverySection form={form} />

              {/* Attributes */}
              <AttributesSection form={form} />
            </div>
          </div>

          {!isEdit && (
            <div className="mt-4">
              <InfoBanner
                title="Next Steps"
                message="After creating this product, manage its product SKU or add customer options from the edit page."
              />
            </div>
          )}

          <AlertDialog open={showAlert} onOpenChange={setShowAlert}>
            <AlertDialogContent aria-describedby="alert-description">
              <AlertDialogHeader>
                <AlertDialogTitle>Validation Error</AlertDialogTitle>
                <AlertDialogDescription id="alert-description">
                  {alertMessage || "Please check the form for errors."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogAction>OK</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </form>
      </Form>
      <ProductActionBar
        isEdit={isEdit}
        isSubmitting={isSubmitting}
        isDirty={form.formState.isDirty}
        onSave={() => form.handleSubmit(handleSubmit)()}
      />
    </>
    </ErrorBoundary>
  );
}
