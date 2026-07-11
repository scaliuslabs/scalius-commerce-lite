// src/components/admin/attributes-manager/components/AttributeValueEditor.tsx
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Badge } from "~/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import {
  Loader2,
  Search,
  Edit3,
  Trash2,
  Check,
  X,
  Package,
  Plus,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import type { AttributeValue } from "../types";
import { getServerFnError } from "~/lib/api-helpers";
import {
  renameAttributeValue,
  addAttributeValue,
  removeAttributeValue,
} from "~/lib/api-functions/attributes";
import { attributeValuesQueryOptions } from "~/lib/api-query-options/attributes";
import { queryKeys } from "~/lib/query-keys";
import { useDebounce } from "~/hooks/use-debounce";
import { AdminListPagination } from "~/components/admin/shared/AdminListPagination";

const ATTRIBUTE_VALUES_PAGE_SIZE = 20;

interface AttributeValueEditorProps {
  attributeId: string | null;
  attributeName: string | null;
  onClose: () => void;
}

export function AttributeValueEditor({
  attributeId,
  attributeName,
  onClose,
}: AttributeValueEditorProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [editingValue, setEditingValue] = useState<string | null>(null);
  const [editedValue, setEditedValue] = useState("");
  const [savingValue, setSavingValue] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [newValue, setNewValue] = useState("");
  const [isAddingNew, setIsAddingNew] = useState(false);
  const queryClient = useQueryClient();
  const debouncedSearch = useDebounce(searchQuery.trim(), 300);

  const valuesQuery = useQuery({
    ...attributeValuesQueryOptions({
      attributeId: attributeId ?? undefined,
      page,
      limit: ATTRIBUTE_VALUES_PAGE_SIZE,
      search: debouncedSearch || undefined,
    }),
    enabled: Boolean(attributeId),
  });

  const values: AttributeValue[] = valuesQuery.data?.values ?? [];
  const isLoading = Boolean(attributeId) && valuesQuery.isPending;

  useEffect(() => {
    setSearchQuery("");
    setPage(1);
    setEditingValue(null);
    setNewValue("");
    setIsAddingNew(false);
  }, [attributeId]);

  useEffect(() => {
    const totalPages = valuesQuery.data?.totalPages ?? 0;
    if (totalPages > 0 && page > totalPages) setPage(totalPages);
  }, [page, valuesQuery.data?.totalPages]);

  const refreshAttributeQueries = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.attributes.all });
  };

  const handleStartEdit = (value: string) => {
    setEditingValue(value);
    setEditedValue(value);
  };

  const handleCancelEdit = () => {
    setEditingValue(null);
    setEditedValue("");
  };

  const handleSaveEdit = async () => {
    if (!attributeId || !editingValue || !editedValue.trim()) return;

    setSavingValue(editingValue);
    try {
      await renameAttributeValue({
        data: {
          attributeId,
          oldValue: editingValue,
          newValue: editedValue.trim(),
        },
      });

      toast.success(`Value renamed to "${editedValue.trim()}"`);
      setEditingValue(null);
      setEditedValue("");
      void refreshAttributeQueries();
    } catch (error: unknown) {
      console.error("Error updating value:", error);
      toast.error(getServerFnError(error, "Failed to update value"));
    } finally {
      setSavingValue(null);
    }
  };

  const handleAddValue = async () => {
    if (!attributeId || !newValue.trim()) return;

    setSavingValue("new");
    try {
      await addAttributeValue({
        data: { attributeId, value: newValue.trim() },
      });

      toast.success(`Value "${newValue.trim()}" added`);
      setNewValue("");
      setIsAddingNew(false);
      void refreshAttributeQueries();
    } catch (error: unknown) {
      console.error("Error adding value:", error);
      toast.error(getServerFnError(error, "Failed to add value"));
    } finally {
      setSavingValue(null);
    }
  };

  const handleDelete = async (value: string) => {
    if (!attributeId) return;

    setSavingValue(value);
    try {
      await removeAttributeValue({ data: { attributeId, value } });

      toast.success(`Value "${value}" deleted from all products`);
      setDeleteConfirm(null);
      void refreshAttributeQueries();
    } catch (error: unknown) {
      console.error("Error deleting value:", error);
      toast.error(getServerFnError(error, "Failed to delete value"));
    } finally {
      setSavingValue(null);
    }
  };

  const totalValues = valuesQuery.data?.totalValues ?? 0;
  const totalProducts = valuesQuery.data?.totalProducts ?? 0;

  return (
    <>
      <Dialog open={!!attributeId} onOpenChange={onClose}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <Edit3 className="h-5 w-5" />
              Edit Values: {attributeName}
            </DialogTitle>
            <DialogDescription>
              Rename or delete values for this attribute. Changes affect all
              products using these values.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 flex-1 overflow-hidden flex flex-col">
            {/* Statistics */}
            <div className="flex gap-3 shrink-0">
              <div className="flex-1 p-3 border rounded-lg">
                <div className="text-sm text-muted-foreground">
                  Unique Values
                </div>
                <div className="text-2xl font-bold">
                  {isLoading || valuesQuery.isError ? "-" : totalValues}
                </div>
              </div>
              <div className="flex-1 p-3 border rounded-lg">
                <div className="text-sm text-muted-foreground">
                  Total Products
                </div>
                <div className="text-2xl font-bold">
                  {isLoading || valuesQuery.isError ? "-" : totalProducts}
                </div>
              </div>
            </div>

            {/* Add Value & Search */}
            <div className="flex gap-2 shrink-0">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search values..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage(1);
                  }}
                  className="pl-10"
                  aria-label="Search attribute values"
                />
              </div>
              <div className="flex gap-2">
                {isAddingNew ? (
                  <div className="flex items-center gap-2 animate-in fade-in slide-in-from-right-5">
                    <Input
                      placeholder="New value"
                      value={newValue}
                      onChange={(e) => setNewValue(e.target.value)}
                      className="w-[200px]"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleAddValue();
                        if (e.key === "Escape") {
                          setIsAddingNew(false);
                          setNewValue("");
                        }
                      }}
                    />
                    <Button
                      size="sm"
                      onClick={handleAddValue}
                      disabled={
                        !newValue.trim() ||
                        savingValue !== null ||
                        valuesQuery.isError
                      }
                      aria-label="Save new value"
                    >
                      <Check className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setIsAddingNew(false);
                        setNewValue("");
                      }}
                      aria-label="Cancel adding value"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <Button
                    onClick={() => setIsAddingNew(true)}
                    disabled={valuesQuery.isError}
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add Value
                  </Button>
                )}
              </div>
            </div>

            {/* Values Table */}
            <div className="border rounded-lg overflow-hidden flex-1 min-h-0 flex flex-col">
              {isLoading ? (
                <div className="flex items-center justify-center flex-1">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : valuesQuery.isError ? (
                <div className="flex flex-col items-center justify-center flex-1 text-center px-6">
                  <AlertTriangle className="h-10 w-10 text-destructive/70 mb-2" />
                  <p className="text-sm font-medium">Could not load attribute values</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Your catalog was not changed. Retry to load the current page.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => void valuesQuery.refetch()}
                  >
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Retry
                  </Button>
                </div>
              ) : values.length > 0 ? (
                <div className="flex-1 overflow-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-background z-10">
                      <TableRow>
                        <TableHead className="bg-muted/50">Value</TableHead>
                        <TableHead className="text-center bg-muted/50 w-24">
                          Products
                        </TableHead>
                        <TableHead className="bg-muted/50 w-32 text-right">
                          Actions
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {values.map((item) => (
                        <TableRow key={item.value}>
                          <TableCell>
                            {editingValue === item.value ? (
                              <div className="flex items-center gap-2">
                                <Input
                                  value={editedValue}
                                  onChange={(e) =>
                                    setEditedValue(e.target.value)
                                  }
                                  className="h-8"
                                  autoFocus
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") handleSaveEdit();
                                    if (e.key === "Escape") handleCancelEdit();
                                  }}
                                />
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8 text-green-600"
                                  onClick={handleSaveEdit}
                                  disabled={savingValue === item.value}
                                  aria-label={`Save rename for ${item.value}`}
                                >
                                  {savingValue === item.value ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <Check className="h-4 w-4" />
                                  )}
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8"
                                  onClick={handleCancelEdit}
                                  aria-label={`Cancel rename for ${item.value}`}
                                >
                                  <X className="h-4 w-4" />
                                </Button>
                              </div>
                            ) : (
                              <span className="font-medium">{item.value}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-center">
                            <div className="flex justify-center gap-1">
                              <Badge
                                variant={
                                  item.productCount > 0
                                    ? "secondary"
                                    : "outline"
                                }
                              >
                                {item.productCount} products
                              </Badge>
                              {item.isPreset && (
                                <Badge
                                  variant="outline"
                                  className="border-primary/50 text-primary"
                                >
                                  Predefined
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            {editingValue !== item.value && (
                              <div className="flex justify-end gap-1">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8"
                                  onClick={() => handleStartEdit(item.value)}
                                  disabled={savingValue !== null}
                                  aria-label={`Rename ${item.value}`}
                                >
                                  <Edit3 className="h-4 w-4" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8 text-destructive hover:text-destructive"
                                  onClick={() => setDeleteConfirm(item.value)}
                                  disabled={savingValue !== null}
                                  aria-label={`Delete ${item.value}`}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center flex-1 text-center">
                  <Package className="h-10 w-10 opacity-40 mb-2" />
                  <p className="text-sm text-muted-foreground">
                    {searchQuery
                      ? "No values match your search"
                      : "No values found for this attribute"}
                  </p>
                </div>
              )}
              {!valuesQuery.isError &&
                valuesQuery.data &&
                valuesQuery.data.totalValues > 0 && (
                  <AdminListPagination
                    pagination={{
                      total: valuesQuery.data.totalValues,
                      page: valuesQuery.data.page,
                      limit: valuesQuery.data.limit,
                      totalPages: valuesQuery.data.totalPages,
                    }}
                    itemLabel="values"
                    onPageChange={setPage}
                  />
                )}
            </div>

            <div className="flex justify-end shrink-0">
              <Button variant="outline" onClick={onClose}>
                <X className="h-4 w-4 mr-2" />
                Close
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={!!deleteConfirm}
        onOpenChange={() => setDeleteConfirm(null)}
        title="Delete Value?"
        description={`This will remove the value "${deleteConfirm}" from all products using it. This action cannot be undone.`}
        confirmLabel="Delete"
        loadingLabel="Deleting..."
        variant="destructive"
        onConfirm={() => deleteConfirm && handleDelete(deleteConfirm)}
      />
    </>
  );
}
