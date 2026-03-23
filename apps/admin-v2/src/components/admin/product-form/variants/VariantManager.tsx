// src/components/admin/ProductForm/variants/VariantManager.tsx

import { useState, useEffect, useMemo } from "react";
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
import { VariantSortModal } from "./VariantSortModal";
import { VariantStatsDisplay } from "./VariantStatsDisplay";
import { VariantDeleteDialogs } from "./VariantDeleteDialogs";
import { useVariantOperations } from "./hooks/useVariantOperations";
import {
  filterVariants,
  sortVariants,
  getVariantStats,
} from "./utils/variantHelpers";
import type {
  ProductVariant,
  VariantFormValues,
  BulkGeneratedVariant,
  VariantFilters,
  VariantSort,
} from "./types";

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
    const filtered = filterVariants(localVariants, filters);
    return sortVariants(filtered, sort);
  }, [localVariants, filters, sort]);

  // Variant statistics
  const stats = useMemo(() => getVariantStats(localVariants), [localVariants]);

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
          onVariantChange ? onVariantChange() : window.dispatchEvent(new CustomEvent("variantChanged"));
          return true;
        }
      } else {
        const savedVariant = await createVariant(productId, values);
        if (savedVariant) {
          setLocalVariants((prev) => [...prev, savedVariant]);
          setIsAdding(false);
          onVariantChange ? onVariantChange() : window.dispatchEvent(new CustomEvent("variantChanged"));
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
      onVariantChange ? onVariantChange() : window.dispatchEvent(new CustomEvent("variantChanged"));
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
      onVariantChange ? onVariantChange() : window.dispatchEvent(new CustomEvent("variantChanged"));
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
      onVariantChange ? onVariantChange() : window.dispatchEvent(new CustomEvent("variantChanged"));
    }

    setIsBulkDeleteDialogOpen(false);
  };

  // Duplicate variant
  const handleDuplicate = async (id: string) => {
    const duplicated = await duplicateVariant(productId, id);
    if (duplicated) {
      setLocalVariants((prev) => [...prev, duplicated]);
      onVariantChange ? onVariantChange() : window.dispatchEvent(new CustomEvent("variantChanged"));
    }
  };

  // Bulk generate variants
  const handleBulkGenerate = async (
    generatedVariants: BulkGeneratedVariant[],
  ) => {
    const created = await bulkCreateVariants(productId, generatedVariants);
    if (created.length > 0) {
      setLocalVariants((prev) => [...prev, ...created]);
      onVariantChange ? onVariantChange() : window.dispatchEvent(new CustomEvent("variantChanged"));
    }
  };

  // Import variants from CSV
  const handleImport = async (importedVariants: BulkGeneratedVariant[]) => {
    const created = await bulkCreateVariants(productId, importedVariants);
    if (created.length > 0) {
      setLocalVariants((prev) => [...prev, ...created]);
      onVariantChange ? onVariantChange() : window.dispatchEvent(new CustomEvent("variantChanged"));
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
      prev.size === filteredAndSortedVariants.length
        ? new Set()
        : new Set(filteredAndSortedVariants.map((v) => v.id)),
    );
  };

  const isAnyRowEditing = isAdding || !!editingVariantId;

  const handleSortUpdated = () => {
    onVariantChange ? onVariantChange() : window.dispatchEvent(new CustomEvent("variantChanged"));
  };

  return (
    <>
      <Card className="border-none shadow-none bg-transparent sm:bg-card">
        <CardHeader className="px-2 pt-2 pb-1.5 sm:px-3 sm:pt-3 sm:pb-2">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base font-semibold tracking-tight flex items-center gap-2">
                Product Variants
                {stats.total > 0 && (
                  <span className="text-xs font-normal text-muted-foreground">
                    ({stats.total} total)
                  </span>
                )}
              </CardTitle>
              <CardDescription className="mt-0 text-xs text-muted-foreground">
                Manage size, color, inventory, and variant-specific pricing.
              </CardDescription>
            </div>

            <div className="flex shrink-0 items-center gap-1.5 flex-wrap sm:flex-nowrap w-full sm:w-auto mt-2 sm:mt-0">
              <VariantStatsDisplay stats={stats} symbol={symbol} />

              {stats.total > 0 && (
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
          <VariantActionsToolbar
            productSlug={productSlug}
            variants={localVariants}
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
              {filteredAndSortedVariants.length !== localVariants.length ? (
                <span>
                  Showing {filteredAndSortedVariants.length} of{" "}
                  {localVariants.length} variants
                </span>
              ) : (
                <span>
                  {localVariants.length} variant
                  {localVariants.length !== 1 ? "s" : ""}
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
      <VariantSortModal
        productId={productId}
        isOpen={isSortModalOpen}
        onClose={() => setIsSortModalOpen(false)}
        onSortUpdated={handleSortUpdated}
      />
    </>
  );
}
