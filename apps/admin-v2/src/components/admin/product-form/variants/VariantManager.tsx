// src/components/admin/ProductForm/variants/VariantManager.tsx

import { lazy, Suspense, useState, useEffect, useMemo } from "react";
import { useCurrency } from "@/hooks/use-currency";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowUpDown } from "lucide-react";
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
import type {
  ProductVariant,
  VariantFormValues,
  BulkGeneratedVariant,
  VariantFilters,
  VariantSort,
} from "./types";

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
  onVariantChange?: () => void;
}

export function VariantManager({
  productId,
  productSlug,
  productName,
  variants,
  onVariantChange,
}: VariantManagerProps) {
  const { symbol } = useCurrency();
  const [localVariants, setLocalVariants] =
    useState<ProductVariant[]>(variants);

  // UI State
  const [isAdding, setIsAdding] = useState(false);
  const [editingVariantId, setEditingVariantId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedVariants, setSelectedVariants] = useState<Set<string>>(
    new Set(),
  );

  const [isBulkEditing, setIsBulkEditing] = useState(false);
  const [draftBulkUpdates, setDraftBulkUpdates] = useState<Record<string, Record<string, unknown>>>({});

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
    bulkUpdateVariants,
    bulkCreateVariants,
    duplicateVariant,
    isLoading,
  } = useVariantOperations();

  // Sync variants when prop changes
  useEffect(() => {
    setLocalVariants(
      variants.map((v) => ({
        ...v,
        createdAt: new Date(v.createdAt),
        updatedAt: new Date(v.updatedAt),
      })),
    );
  }, [variants]);

  const variantMode = useMemo(
    () => getVariantManagementMode(localVariants),
    [localVariants],
  );
  const matrixVariants = useMemo(() => {
    if (variantMode.mode === "optioned") return variantMode.variants;
    if (variantMode.mode === "simple" && isAdding) return [];
    return localVariants;
  }, [isAdding, localVariants, variantMode]);

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
    } else {
      setIsBulkEditing(true);
      setDraftBulkUpdates({});
      setIsAdding(false);
      setEditingVariantId(null);
    }
  };

  const handleBulkEditChange = (variantId: string, field: string, value: unknown) => {
    setDraftBulkUpdates((prev) => ({
      ...prev,
      [variantId]: {
        ...(prev[variantId] || {}),
        [field]: value,
      },
    }));
  };

  const handleSaveBulkEdit = async () => {
    const updates = Object.entries(draftBulkUpdates).map(([id, changes]) => ({
      id,
      ...changes,
    }));

    if (updates.length === 0) {
      handleToggleBulkEdit();
      return;
    }

    const success = await bulkUpdateVariants(productId, updates);
    if (success) {
      setLocalVariants((prev) =>
        prev.map((v) => {
          const update = draftBulkUpdates[v.id];
          return update ? { ...v, ...update } : v;
        }),
      );
      onVariantChange?.();
      handleToggleBulkEdit();
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

  // Duplicate variant
  const handleDuplicate = async (id: string) => {
    const duplicated = await duplicateVariant(productId, id);
    if (duplicated) {
      setLocalVariants((prev) => [...prev, duplicated]);
      onVariantChange?.();
    }
  };

  // Bulk generate variants
  const handleBulkGenerate = async (
    generatedVariants: BulkGeneratedVariant[],
  ) => {
    const created = await bulkCreateVariants(productId, generatedVariants);
    if (created.length > 0) {
      setLocalVariants((prev) => [...prev, ...created]);
      onVariantChange?.();
    }
  };

  // Import variants from CSV
  const handleImport = async (importedVariants: BulkGeneratedVariant[]) => {
    const created = await bulkCreateVariants(productId, importedVariants);
    if (created.length > 0) {
      setLocalVariants((prev) => [...prev, ...created]);
      onVariantChange?.();
    }
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
        isSubmitting={isSubmitting}
      />
    );
  }

  const isFirstOptionSetup = variantMode.mode === "simple" && isAdding;
  const description = isFirstOptionSetup
    ? "Add the first size or color option. The simple SKU stays protected and hidden from this table."
    : "Manage customer choices, option-specific pricing, and stock.";

  return (
    <>
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
            />
          )}

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
            onAddVariant={() => {
              setIsAdding(true);
              setEditingVariantId(null);
            }}
            isBulkEditing={isBulkEditing}
            draftUpdates={draftBulkUpdates}
            onBulkEditChange={handleBulkEditChange}
            productName={productName}
          />

          {/* Variant count footer */}
          {localVariants.length > 0 && !isAdding && (
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
          />
        </Suspense>
      ) : null}
    </>
  );
}
