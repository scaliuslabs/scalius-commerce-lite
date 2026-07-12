// src/components/admin/ProductForm/variants/VariantManager.tsx

import {
  lazy,
  Suspense,
  useState,
  useMemo,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useCurrency } from "@/hooks/use-currency";
import { getServerFnError } from "@/lib/api-mutations/shared";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { UnsavedChangesGuard } from "@/components/admin/shared/UnsavedChangesGuard";
import { ArrowUpDown, PackageCheck } from "lucide-react";
import { VariantActionsToolbar } from "./VariantActionsToolbar";
import { VariantTable } from "./VariantTable";
import { VariantStatsDisplay } from "./VariantStatsDisplay";
import { VariantDeleteDialogs } from "./VariantDeleteDialogs";
import { SimpleProductSkuPanel } from "./SimpleProductSkuPanel";
import { useVariantOperations } from "./hooks/useVariantOperations";
import {
  filterVariants,
  sortVariants,
  getVariantStats,
} from "./utils/variantHelpers";
import { getVariantManagementMode } from "./utils/variantMode";
import { buildDuplicateVariantDraft } from "./utils/duplicateVariantDraft";
import {
  normalizeVariantOptionLabels,
  type ProductVariant,
  type VariantBulkEditField,
  type VariantBulkEditValue,
  type VariantFormValues,
  type BulkGeneratedVariant,
  type VariantFilters,
  type VariantSort,
  type VariantOptionLabels,
} from "./types";
import type { ProductRevisionConflict } from "@/lib/admin-api-error";

function SimpleSkuTransitionSummary({
  variant,
  symbol,
  onCancel,
}: {
  variant: ProductVariant;
  symbol: string;
  onCancel: () => void;
}) {
  const inventoryTracked = variant.trackInventory !== false;
  const available = Math.max(0, variant.stock - (variant.reservedStock ?? 0));

  return (
    <div className="mx-2 rounded-md border border-sky-200 bg-sky-50/70 p-3 text-sky-950 sm:mx-3 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-100">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-2">
          <PackageCheck className="mt-0.5 h-4 w-4 shrink-0 text-sky-700 dark:text-sky-300" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
              <span>Product SKU</span>
              <Badge variant="outline" className="h-5 border-sky-300 bg-white/70 px-1.5 text-[10px] text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200">
                Protected
              </Badge>
              {inventoryTracked ? (
                <Badge variant="outline" className="h-5 border-emerald-300 bg-white/70 px-1.5 text-[10px] text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
                  {available} available
                </Badge>
              ) : (
                <Badge variant="outline" className="h-5 border-emerald-300 bg-white/70 px-1.5 text-[10px] text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
                  No stock limit
                </Badge>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-sky-800 dark:text-sky-200">
              <span className="font-mono">{variant.sku}</span>
              <span suppressHydrationWarning>
                {symbol}
                {variant.price.toLocaleString("en-IN", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
            </div>
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onCancel} className="h-8 shrink-0 bg-background text-xs">
          Keep simple product
        </Button>
      </div>
    </div>
  );
}

function firstOptionDefaultsFromSimpleSku(variant: ProductVariant): Partial<VariantFormValues> {
  return {
    size: "",
    color: "",
    weight: variant.weight,
    sku: "",
    barcode: null,
    barcodeType: null,
    price: variant.price,
    stock: variant.trackInventory === false ? 0 : variant.stock,
    trackInventory: variant.trackInventory ?? true,
    discountType: variant.discountType,
    discountPercentage: variant.discountType === "percentage" ? variant.discountPercentage : null,
    discountAmount: variant.discountType === "flat" ? variant.discountAmount : null,
  };
}

const VariantSortModal = lazy(() =>
  import("./VariantSortModal").then((module) => ({
    default: module.VariantSortModal,
  })),
);

interface VariantManagerProps {
  productId: string;
  productSlug?: string;
  productName?: string;
  variants: ProductVariant[];
  onVariantsChange: Dispatch<SetStateAction<ProductVariant[]>>;
  optionLabels?: VariantOptionLabels;
  aggregateRevision: number;
  revisionConflict: ProductRevisionConflict | null;
  onAggregateRevisionChange: (revision: number) => void;
  onRevisionConflict: (conflict: ProductRevisionConflict) => void;
  onOpenRevisionConflict: () => void;
  onVariantChange?: () => void;
}

type BulkVariantDraftUpdate = {
  id: string;
  size?: string | null;
  color?: string | null;
  weight?: number | null;
  sku?: string;
  price?: number;
  stock?: number;
  trackInventory?: boolean;
};

type BulkVariantDraftChanges = Omit<Partial<BulkVariantDraftUpdate>, "id">;

export function VariantManager({
  productId,
  productSlug,
  productName,
  variants,
  onVariantsChange,
  optionLabels,
  aggregateRevision,
  revisionConflict,
  onAggregateRevisionChange,
  onRevisionConflict,
  onOpenRevisionConflict,
  onVariantChange,
}: VariantManagerProps) {
  const { symbol } = useCurrency();
  const normalizedOptionLabels = useMemo(
    () => normalizeVariantOptionLabels(optionLabels),
    [optionLabels],
  );
  const localVariants = variants;
  const setLocalVariants = onVariantsChange;

  // UI State
  const [isAdding, setIsAdding] = useState(false);
  const [newVariantDefaults, setNewVariantDefaults] =
    useState<Partial<VariantFormValues> | null>(null);
  const [editingVariantId, setEditingVariantId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedVariants, setSelectedVariants] = useState<Set<string>>(
    new Set(),
  );

  const [isBulkEditing, setIsBulkEditing] = useState(false);
  const [draftBulkUpdates, setDraftBulkUpdates] = useState<Record<string, BulkVariantDraftChanges>>({});
  const [draftNewIds, setDraftNewIds] = useState<string[]>([]);
  const [bulkEditError, setBulkEditError] = useState<string | null>(null);

  // Filter and Sort State
  const [searchTerm, setSearchTerm] = useState("");
  const [sort, setSort] = useState<VariantSort>({
    field: "size",
    order: "desc",
  });

  // Dialog State
  const [variantToDelete, setVariantToDelete] = useState<string | null>(null);
  const [isBulkDeleteDialogOpen, setIsBulkDeleteDialogOpen] = useState(false);
  const [isSortModalOpen, setIsSortModalOpen] = useState(false);

  // Hooks
  const {
    createVariant,
    updateVariant,
    deleteVariant,
    bulkDeleteVariants,
    bulkCreateVariants,
    applyVariantEditPlan,
    isLoading,
  } = useVariantOperations({
    aggregateRevision,
    revisionConflict,
    onAggregateRevisionChange,
    onRevisionConflict,
    onOpenRevisionConflict,
  });

  const activeVariants = useMemo(
    () => localVariants.filter((variant) => variant.deletedAt === null),
    [localVariants],
  );
  const variantMode = useMemo(
    () => getVariantManagementMode(activeVariants),
    [activeVariants],
  );
  const simpleVariantForSetup = variantMode.mode === "simple" ? variantMode.variant : null;
  const reservedVariants = variantMode.mode === "optioned" && variantMode.hiddenSimpleSku
    ? [variantMode.hiddenSimpleSku]
    : [];
  const addVariantDefaults = simpleVariantForSetup
    ? firstOptionDefaultsFromSimpleSku(simpleVariantForSetup)
    : undefined;
  const matrixVariants = useMemo(() => {
    if (variantMode.mode === "optioned") return variantMode.variants;
    if (variantMode.mode === "ambiguous") return variantMode.variants;
    if (variantMode.mode === "simple" && isAdding) return [];
    return activeVariants;
  }, [activeVariants, isAdding, variantMode]);

  // Filter and sort variants
  const filters: VariantFilters = useMemo(
    () => ({
      searchTerm,
      sizes: [],
      colors: [],
    }),
    [searchTerm],
  );

  const filteredAndSortedVariants = useMemo(() => {
    const filtered = filterVariants(matrixVariants, filters);
    return sortVariants(filtered, sort);
  }, [matrixVariants, filters, sort]);

  const selectableFilteredVariants = useMemo(
    () => filteredAndSortedVariants.filter((variant) => !variant.isDefault),
    [filteredAndSortedVariants],
  );

  // Variant statistics
  const stats = useMemo(() => getVariantStats(matrixVariants), [matrixVariants]);

  // Save variant (create or update)
  const handleSaveVariant = async (
    values: VariantFormValues,
  ): Promise<boolean> => {
    setIsSubmitting(true);
    try {
      if (editingVariantId) {
        const savedVariant = await updateVariant(
          productId,
          editingVariantId,
          values,
        );
        if (savedVariant) {
          setLocalVariants((prev) =>
            prev.map((v) => (v.id === savedVariant.id ? savedVariant : v)),
          );
          setEditingVariantId(null);
          onVariantChange?.();
          return true;
        }
      } else {
        const savedVariant = await createVariant(productId, values);
        if (savedVariant) {
          setLocalVariants((prev) => [...prev, savedVariant]);
          setIsAdding(false);
          setNewVariantDefaults(null);
          onVariantChange?.();
          return true;
        }
      }
      return false;
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelEdit = () => {
    setIsAdding(false);
    setNewVariantDefaults(null);
    setEditingVariantId(null);
  };

  const handleSaveSimpleSku = async (
    variantId: string,
    values: VariantFormValues,
  ): Promise<boolean> => {
    setIsSubmitting(true);
    try {
      const savedVariant = await updateVariant(productId, variantId, values);
      if (!savedVariant) return false;
      setLocalVariants((prev) =>
        prev.map((variant) => (variant.id === savedVariant.id ? savedVariant : variant)),
      );
      onVariantChange?.();
      return true;
    } finally {
      setIsSubmitting(false);
    }
  };

  // Bulk Edit Mode
  const handleToggleBulkEdit = () => {
    if (isBulkEditing) {
      setIsBulkEditing(false);
      setDraftBulkUpdates({});
      setDraftNewIds([]);
      setBulkEditError(null);
    } else {
      setIsBulkEditing(true);
      setDraftBulkUpdates({});
      setDraftNewIds([]);
      setBulkEditError(null);
      setIsAdding(false);
      setNewVariantDefaults(null);
      setEditingVariantId(null);
    }
  };

  const handleBulkEditChange = (variantId: string, field: VariantBulkEditField, value: VariantBulkEditValue) => {
    setBulkEditError(null);
    setDraftBulkUpdates((prev) => ({
      ...prev,
      [variantId]: {
        ...(prev[variantId] || {}),
        [field]: value,
      },
    }));
  };

  const handleAddBulkRow = () => {
    setBulkEditError(null);
    const newId = `new-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    setDraftNewIds((prev) => [...prev, newId]);

    // Provide some default values for the new row
    setDraftBulkUpdates((prev) => ({
      ...prev,
      [newId]: {
        sku: '',
        price: 0,
        stock: 0,
        trackInventory: true,
      },
    }));
  };

  const handleRemoveBulkRow = (id: string) => {
    setBulkEditError(null);
    setDraftNewIds((prev) => prev.filter((newId) => newId !== id));
    setDraftBulkUpdates((prev) => {
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });
  };

  const handleSaveBulkEdit = async () => {
    const allDrafts = Object.entries(draftBulkUpdates);

    const newDrafts = allDrafts
      .filter(([id]) => draftNewIds.includes(id))
      .map(([, changes]) => ({
        ...changes,
        sku: changes.sku || '',
        price: changes.price || 0,
        stock: changes.trackInventory === false ? 0 : (changes.stock || 0),
        trackInventory: changes.trackInventory ?? true,
        size: changes.size || null,
        color: changes.color || null,
        weight: changes.weight ?? null,
        discountType: "percentage" as const,
        discountAmount: null,
        discountPercentage: null,
        barcode: null,
        barcodeType: null,
      }));

    const updateDrafts = allDrafts
      .filter(([id]) => !draftNewIds.includes(id))
      .map(([id, changes]) => ({
        id,
        ...changes,
      })).map((update) => {
        if (update.trackInventory !== false) return update;
        const withoutIgnoredStock = { ...update };
        delete withoutIgnoredStock.stock;
        return withoutIgnoredStock;
      });

    if (newDrafts.length === 0 && updateDrafts.length === 0) {
      handleToggleBulkEdit();
      return;
    }

    setIsSubmitting(true);
    try {
      setBulkEditError(null);
      const result = await applyVariantEditPlan(
        productId,
        newDrafts,
        updateDrafts,
      );
      if (!result) return;
      const updatedById = new Map(result.updated.map((variant) => [variant.id, variant]));
      setLocalVariants((previous) => [
        ...previous.map((variant) => updatedById.get(variant.id) ?? variant),
        ...result.created,
      ]);
      onVariantChange?.();
      handleToggleBulkEdit();
    } catch (error) {
      setBulkEditError(
        getServerFnError(
          error,
          "Option changes were not saved. Review the highlighted values and try again.",
        ),
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  // Delete single variant
  const handleDelete = (id: string) => {
    setVariantToDelete(id);
  };

  const confirmDelete = async () => {
    if (!variantToDelete) return;

    const originalVariants = [...localVariants];
    setLocalVariants((prev) => prev.filter((v) => v.id !== variantToDelete));

    const success = await deleteVariant(productId, variantToDelete);

    if (!success) {
      setLocalVariants(originalVariants);
    } else {
      setSelectedVariants((prev) => {
        const newSet = new Set(prev);
        newSet.delete(variantToDelete);
        return newSet;
      });
      onVariantChange?.();
    }

    setVariantToDelete(null);
  };

  // Bulk delete variants
  const handleBulkDelete = () => {
    if (selectedVariants.size === 0) return;
    setIsBulkDeleteDialogOpen(true);
  };

  const confirmBulkDelete = async () => {
    const idsToDelete = Array.from(selectedVariants);
    const originalVariants = [...localVariants];
    setLocalVariants((prev) => prev.filter((v) => !idsToDelete.includes(v.id)));

    const success = await bulkDeleteVariants(productId, idsToDelete);

    if (!success) {
      setLocalVariants(originalVariants);
    } else {
      setSelectedVariants(new Set());
      onVariantChange?.();
    }

    setIsBulkDeleteDialogOpen(false);
  };

  // Duplicate starts a draft. Unique identifiers and physical stock never copy.
  const handleDuplicate = (id: string) => {
    const source = localVariants.find((variant) => variant.id === id);
    if (!source) return;

    setNewVariantDefaults(buildDuplicateVariantDraft(source));
    setEditingVariantId(null);
    setIsAdding(true);
  };

  // Bulk generate variants
  const handleBulkGenerate = async (
    generatedVariants: BulkGeneratedVariant[],
  ) => {
    const created = await bulkCreateVariants(productId, generatedVariants);
    if (created.length === 0) {
      throw new Error("No options were created.");
    }
    setLocalVariants((prev) => [...prev, ...created]);
    onVariantChange?.();
  };

  // Import variants from CSV
  const handleImport = async (importedVariants: BulkGeneratedVariant[]) => {
    const created = await bulkCreateVariants(productId, importedVariants);
    if (created.length === 0) {
      throw new Error("No options were imported.");
    }
    setLocalVariants((prev) => [...prev, ...created]);
    onVariantChange?.();
  };

  // Selection handlers
  const toggleSelection = (id: string) => {
    setSelectedVariants((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(id)) newSet.delete(id);
      else newSet.add(id);
      return newSet;
    });
  };

  const toggleAllSelection = () => {
    setSelectedVariants((prev) =>
      selectableFilteredVariants.length > 0 && selectableFilteredVariants.every((variant) => prev.has(variant.id))
        ? new Set()
        : new Set(selectableFilteredVariants.map((v) => v.id)),
    );
  };

  const isAnyRowEditing = isAdding || !!editingVariantId;
  const hasUnsavedVariantDrafts =
    isAnyRowEditing ||
    (isBulkEditing &&
      (draftNewIds.length > 0 || Object.keys(draftBulkUpdates).length > 0));

  const handleSortUpdated = () => {
    onVariantChange?.();
  };

  if (variantMode.mode === "simple" && !isAdding) {
    return (
      <SimpleProductSkuPanel
        variant={variantMode.variant}
        onSave={handleSaveSimpleSku}
        onAddOption={() => {
          setIsAdding(true);
          setEditingVariantId(null);
        }}
        onGenerateOptions={handleBulkGenerate}
        productSlug={productSlug}
        optionLabels={normalizedOptionLabels}
        isSubmitting={isSubmitting}
      />
    );
  }

  const isFirstOptionSetup = variantMode.mode === "simple" && isAdding;
  const description = isFirstOptionSetup
    ? "Create the first option choice. The product SKU stays protected while option SKUs take over selling."
    : "Manage customer choices, option-specific pricing, and stock.";

  return (
    <>
      <UnsavedChangesGuard
        isDirty={hasUnsavedVariantDrafts}
        isSubmitting={isSubmitting}
      />
      <Card className="border-none shadow-none bg-transparent sm:bg-card">
        <CardHeader className="px-2 pt-2 pb-1.5 sm:px-3 sm:pt-3 sm:pb-2">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base font-semibold tracking-tight flex items-center gap-2">
                Product Options
                {stats.total > 0 && (
                  <span className="text-xs font-normal text-muted-foreground">
                    ({stats.total} total)
                  </span>
                )}
              </CardTitle>
              <CardDescription className="mt-0 text-xs text-muted-foreground">
                {description}
              </CardDescription>
            </div>

            <div className="flex shrink-0 items-center gap-1.5 flex-wrap sm:flex-nowrap w-full sm:w-auto mt-2 sm:mt-0">
              <VariantStatsDisplay stats={stats} symbol={symbol} />

              {stats.total > 0 && !isFirstOptionSetup && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setIsSortModalOpen(true)}
                  disabled={isAnyRowEditing}
                  className="h-7 text-xs ml-auto sm:ml-0"
                >
                  <ArrowUpDown className="h-3.5 w-3.5 mr-1" />
                  Reorder
                </Button>
              )}
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-2 p-0">
          {!isFirstOptionSetup && (
            <VariantActionsToolbar
              productSlug={productSlug}
              variants={matrixVariants}
              reservedVariants={reservedVariants}
              selectedCount={selectedVariants.size}
              searchTerm={searchTerm}
              onSearchChange={setSearchTerm}
              sortField={sort.field}
              sortOrder={sort.order}
              onSortChange={(field, order) => setSort({ field, order })}
              onAddVariant={() => {
                setIsAdding(true);
                setEditingVariantId(null);
              }}
              onBulkDelete={handleBulkDelete}
              onBulkGenerate={handleBulkGenerate}
              onImport={handleImport}
              disabled={isAnyRowEditing || isBulkEditing}
              isBulkEditing={isBulkEditing}
              onToggleBulkEdit={handleToggleBulkEdit}
              onSaveBulkEdit={handleSaveBulkEdit}
              optionLabels={normalizedOptionLabels}
            />
          )}

          {isBulkEditing && bulkEditError ? (
            <div
              role="alert"
              className="mx-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive sm:mx-3"
            >
              {bulkEditError}
            </div>
          ) : null}

          {isFirstOptionSetup && simpleVariantForSetup ? (
            <SimpleSkuTransitionSummary
              variant={simpleVariantForSetup}
              symbol={symbol}
              onCancel={handleCancelEdit}
            />
          ) : null}

          <VariantTable
            variants={filteredAndSortedVariants}
            selectedVariants={selectedVariants}
            editingVariantId={editingVariantId}
            isAdding={isAdding}
            isSubmitting={isSubmitting}
            onToggleSelection={toggleSelection}
            onToggleAllSelection={toggleAllSelection}
            onEdit={(id) => setEditingVariantId(id)}
            onDelete={handleDelete}
            onDuplicate={handleDuplicate}
            onSaveVariant={handleSaveVariant}
            onCancelEdit={handleCancelEdit}
            isAnyRowEditing={isAnyRowEditing}
            onAddVariant={() => setIsAdding(true)}
            isBulkEditing={isBulkEditing}
            draftUpdates={draftBulkUpdates}
            draftNewIds={draftNewIds}
            onBulkEditChange={handleBulkEditChange}
            onAddBulkRow={handleAddBulkRow}
            onRemoveBulkRow={handleRemoveBulkRow}
            productName={productName}
            addVariantDefaults={
              newVariantDefaults ??
              (isFirstOptionSetup ? addVariantDefaults : undefined)
            }
            optionLabels={normalizedOptionLabels}
          />

          {/* Variant count footer */}
          {activeVariants.length > 0 && !isAdding && (
            <div className="p-2 sm:p-3 border-t text-xs text-muted-foreground text-center sm:text-left">
              {filteredAndSortedVariants.length !== matrixVariants.length ? (
                <span>
                  Showing {filteredAndSortedVariants.length} of{" "}
                  {matrixVariants.length} options
                </span>
              ) : (
                <span>
                  {matrixVariants.length} option
                  {matrixVariants.length !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialogs */}
      <VariantDeleteDialogs
        variantToDelete={variantToDelete}
        onCancelDelete={() => setVariantToDelete(null)}
        onConfirmDelete={confirmDelete}
        isBulkDeleteDialogOpen={isBulkDeleteDialogOpen}
        onCloseBulkDeleteDialog={setIsBulkDeleteDialogOpen}
        selectedCount={selectedVariants.size}
        onConfirmBulkDelete={confirmBulkDelete}
        isLoading={isLoading}
      />

      {/* Variant Sort Modal */}
      {isSortModalOpen ? (
        <Suspense fallback={null}>
          <VariantSortModal
            productId={productId}
            isOpen={isSortModalOpen}
            onClose={() => setIsSortModalOpen(false)}
            onSortUpdated={handleSortUpdated}
            optionLabels={normalizedOptionLabels}
            aggregateRevision={aggregateRevision}
            revisionConflict={revisionConflict}
            onAggregateRevisionChange={onAggregateRevisionChange}
            onRevisionConflict={onRevisionConflict}
            onOpenRevisionConflict={onOpenRevisionConflict}
          />
        </Suspense>
      ) : null}
    </>
  );
}
