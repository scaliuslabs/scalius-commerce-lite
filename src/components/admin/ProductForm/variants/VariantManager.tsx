// src/components/admin/ProductForm/variants/VariantManager.tsx

import { useState, useEffect, useMemo } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Loader2, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { VariantActionsToolbar } from "./VariantActionsToolbar";
import { VariantTable } from "./VariantTable";
import { VariantSortModal } from "./VariantSortModal";
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
  variants: ProductVariant[];
}

export function VariantManager({
  productId,
  productSlug,
  variants,
}: VariantManagerProps) {
  const [localVariants, setLocalVariants] =
    useState<ProductVariant[]>(variants);

  // UI State
  const [isAdding, setIsAdding] = useState(false);
  const [editingVariantId, setEditingVariantId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedVariants, setSelectedVariants] = useState<Set<string>>(
    new Set(),
  );

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
        // Update existing variant
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
          // Dispatch event to notify ProductForm about variant change
          window.dispatchEvent(new CustomEvent("variantChanged"));
          return true;
        }
      } else {
        // Create new variant
        const savedVariant = await createVariant(productId, values);
        if (savedVariant) {
          setLocalVariants((prev) => [...prev, savedVariant]);
          setIsAdding(false);
          // Dispatch event to notify ProductForm about variant change
          window.dispatchEvent(new CustomEvent("variantChanged"));
          return true;
        }
      }
      return false;
    } finally {
      setIsSubmitting(false);
    }
  };

  // Cancel add/edit
  const handleCancelEdit = () => {
    setIsAdding(false);
    setEditingVariantId(null);
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
      // Dispatch event to notify ProductForm about variant change
      window.dispatchEvent(new CustomEvent("variantChanged"));
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
      // Dispatch event to notify ProductForm about variant change
      window.dispatchEvent(new CustomEvent("variantChanged"));
    }

    setIsBulkDeleteDialogOpen(false);
  };

  // Duplicate variant
  const handleDuplicate = async (id: string) => {
    const duplicated = await duplicateVariant(productId, id);
    if (duplicated) {
      setLocalVariants((prev) => [...prev, duplicated]);
      // Dispatch event to notify ProductForm about variant change
      window.dispatchEvent(new CustomEvent("variantChanged"));
    }
  };

  // Bulk generate variants
  const handleBulkGenerate = async (
    generatedVariants: BulkGeneratedVariant[],
  ) => {
    const created = await bulkCreateVariants(productId, generatedVariants);
    if (created.length > 0) {
      setLocalVariants((prev) => [...prev, ...created]);
      // Dispatch event to notify ProductForm about variant change
      window.dispatchEvent(new CustomEvent("variantChanged"));
    }
  };

  // Import variants from CSV
  const handleImport = async (importedVariants: BulkGeneratedVariant[]) => {
    const created = await bulkCreateVariants(productId, importedVariants);
    if (created.length > 0) {
      setLocalVariants((prev) => [...prev, ...created]);
      // Dispatch event to notify ProductForm about variant change
      window.dispatchEvent(new CustomEvent("variantChanged"));
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
    if (selectedVariants.size === filteredAndSortedVariants.length) {
      setSelectedVariants(new Set());
    } else {
      setSelectedVariants(new Set(filteredAndSortedVariants.map((v) => v.id)));
    }
  };

  const isAnyRowEditing = isAdding || !!editingVariantId;

  // Handle sort update
  const handleSortUpdated = () => {
    // Trigger variant refresh to get updated order
    window.dispatchEvent(new CustomEvent("variantChanged"));
  };

  return (
    <>
      <Card className="relative">
        <CardHeader className="pb-3 pt-4 px-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between cursor-default">
            <div className="space-y-1">
              <CardTitle className="text-lg font-semibold flex items-center gap-2">
                Product Variants
                {stats.total > 0 && (
                  <span className="text-xs font-normal text-muted-foreground">
                    ({stats.total} total)
                  </span>
                )}
              </CardTitle>
              <CardDescription className="text-xs">
                Manage size, color, and inventory.
              </CardDescription>
            </div>

            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
              {/* Stats Row */}
              {stats.total > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground bg-muted/40 px-3 py-1.5 rounded-md border">
                  <span>
                    Stock:{" "}
                    <span className="font-medium text-foreground">
                      {stats.totalStock}
                    </span>
                  </span>
                  <span className="text-muted-foreground/30">|</span>
                  <span>
                    Avg:{" "}
                    <span className="font-medium text-foreground">
                      ৳{stats.averagePrice.toFixed(2)}
                    </span>
                  </span>

                  {(stats.lowStockCount > 0 || stats.outOfStockCount > 0) && (
                    <span className="text-muted-foreground/30">|</span>
                  )}

                  {stats.lowStockCount > 0 && (
                    <span className="font-medium text-amber-600 dark:text-amber-500 bg-amber-100 dark:bg-amber-900/30 px-1.5 py-0.5 rounded">
                      {stats.lowStockCount} Low
                    </span>
                  )}
                  {stats.outOfStockCount > 0 && (
                    <span className="font-medium text-destructive bg-destructive/10 px-1.5 py-0.5 rounded">
                      {stats.outOfStockCount} Out
                    </span>
                  )}
                </div>
              )}

              {stats.total > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsSortModalOpen(true)}
                  disabled={isAnyRowEditing}
                  className="h-8 text-xs gap-2 ml-auto sm:ml-0"
                >
                  <ArrowUpDown className="h-3.5 w-3.5" />
                  Reorder Values
                </Button>
              )}
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-3 p-4">
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
            disabled={isAnyRowEditing}
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
          />

          {/* Variant count footer */}
          {localVariants.length > 0 && !isAdding && (
            <div className="pt-1 text-xs text-muted-foreground text-center">
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
      <AlertDialog
        open={!!variantToDelete}
        onOpenChange={(open) => !open && setVariantToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the
              variant.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className={cn("bg-destructive hover:bg-destructive/90")}
            >
              {isLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={isBulkDeleteDialogOpen}
        onOpenChange={setIsBulkDeleteDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedVariants.size} variants?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This action is permanent and cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmBulkDelete}
              className={cn("bg-destructive hover:bg-destructive/90")}
            >
              {isLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Confirm Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
