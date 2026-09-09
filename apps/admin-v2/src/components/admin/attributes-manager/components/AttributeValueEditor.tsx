// src/components/admin/attributes-manager/components/AttributeValueEditor.tsx
import { useEffect, useRef, useState } from "react";
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
  openerRef: React.RefObject<HTMLElement | null>;
}

export function AttributeValueEditor({
  attributeId,
  attributeName,
  onClose,
  openerRef,
}: AttributeValueEditorProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [editingValue, setEditingValue] = useState<string | null>(null);
  const [editedValue, setEditedValue] = useState("");
  const [savingValue, setSavingValue] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [newValue, setNewValue] = useState("");
  const [isAddingNew, setIsAddingNew] = useState(false);
  const commandInFlight = useRef(false);
  const pending = savingValue !== null;
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
    const totalPages = valuesQuery.data?.totalPages ?? 0;
    if (totalPages > 0 && page > totalPages) setPage(totalPages);
  }, [page, valuesQuery.data?.totalPages]);

  const refreshAttributeQueries = async () => {
    await queryClient.invalidateQueries(
      { queryKey: queryKeys.attributes.all },
      { throwOnError: false },
    );
  };

  const handleClose = () => {
    if (!commandInFlight.current) onClose();
  };

  const handleCancelAdd = () => {
    if (commandInFlight.current) return;
    setIsAddingNew(false);
    setNewValue("");
  };

  const handleStartEdit = (value: string) => {
    if (commandInFlight.current) return;
    setEditingValue(value);
    setEditedValue(value);
  };

  const handleCancelEdit = () => {
    if (commandInFlight.current) return;
    setEditingValue(null);
    setEditedValue("");
  };

  const handleSaveEdit = async () => {
    if (commandInFlight.current || !attributeId || !editingValue || !editedValue.trim()) return;

    commandInFlight.current = true;
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
      await refreshAttributeQueries();
    } catch (error: unknown) {
      console.error("Error updating value:", error);
      toast.error(getServerFnError(error, "Failed to update value"));
    } finally {
      commandInFlight.current = false;
      setSavingValue(null);
    }
  };

  const handleAddValue = async () => {
    if (commandInFlight.current || !attributeId || !newValue.trim()) return;

    commandInFlight.current = true;
    setSavingValue("new");
    try {
      await addAttributeValue({
        data: { attributeId, value: newValue.trim() },
      });

      toast.success(`Value "${newValue.trim()}" added`);
      setNewValue("");
      setIsAddingNew(false);
      await refreshAttributeQueries();
    } catch (error: unknown) {
      console.error("Error adding value:", error);
      toast.error(getServerFnError(error, "Failed to add value"));
    } finally {
      commandInFlight.current = false;
      setSavingValue(null);
    }
  };

  const handleDelete = async (value: string) => {
    if (commandInFlight.current || !attributeId) return;

    commandInFlight.current = true;
    setSavingValue(value);
    try {
      await removeAttributeValue({ data: { attributeId, value } });

      toast.success(`Value "${value}" deleted from all products`);
      setDeleteConfirm(null);
      await refreshAttributeQueries();
    } catch (error: unknown) {
      console.error("Error deleting value:", error);
      toast.error(getServerFnError(error, "Failed to delete value"));
    } finally {
      commandInFlight.current = false;
      setSavingValue(null);
    }
  };

  const totalValues = valuesQuery.data?.totalValues ?? 0;
  const totalProducts = valuesQuery.data?.totalProducts ?? 0;

  return (
    <>
      <Dialog open={!!attributeId} onOpenChange={handleClose}>
        <DialogContent
          className="max-w-3xl overflow-y-auto flex flex-col"
          showCloseButton={!pending}
          onCloseAutoFocus={(event) => {
            if (openerRef.current?.isConnected) {
              event.preventDefault();
              openerRef.current.focus();
            }
          }}
        >
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex min-w-0 items-center gap-2 pr-8 [overflow-wrap:anywhere]">
              <Edit3 className="h-5 w-5 shrink-0" />
              Edit Values: {attributeName}
            </DialogTitle>
            <DialogDescription>
              Rename or delete values for this attribute. Changes affect all
              products using these values.
            </DialogDescription>
          </DialogHeader>

          <fieldset disabled={pending} className="grid min-h-0 min-w-0 flex-1 grid-rows-[auto_auto_minmax(16rem,1fr)_auto] gap-4">
            {/* Statistics */}
            <p className="text-sm text-muted-foreground">
              Unique values: <span className="font-medium text-foreground">{isLoading || valuesQuery.isError ? "-" : totalValues}</span>
              {" · "}
              Products: <span className="font-medium text-foreground">{isLoading || valuesQuery.isError ? "-" : totalProducts}</span>
            </p>

            {/* Add Value & Search */}
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
              <div className="relative min-w-0 flex-1">
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
              <div className="flex min-w-0 gap-2 sm:shrink-0">
                {isAddingNew ? (
                  <div className="flex min-w-0 flex-1 items-center gap-2 animate-in fade-in slide-in-from-right-5">
                    <Input
                      placeholder="New value"
                      aria-label="New attribute value"
                      value={newValue}
                      onChange={(e) => setNewValue(e.target.value)}
                      className="min-w-0 flex-1 sm:w-[200px] sm:flex-none"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handleAddValue();
                        }
                        if (e.key === "Escape") handleCancelAdd();
                      }}
                    />
                    <Button
                      size="sm"
                      className="shrink-0"
                      onClick={handleAddValue}
                      disabled={
                        !newValue.trim() ||
                        savingValue !== null ||
                        valuesQuery.isError
                      }
                      aria-label="Save new value"
                    >
                      {pending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="shrink-0"
                      onClick={handleCancelAdd}
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
            <div className="border rounded-lg overflow-hidden min-h-0 min-w-0 flex flex-col">
              {isLoading ? (
                <div className="flex items-center justify-center flex-1">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : valuesQuery.isError ? (
                <div className="flex min-h-0 flex-1 flex-col items-center overflow-auto px-6 py-4 text-center [justify-content:safe_center]">
                  <AlertTriangle className="h-10 w-10 shrink-0 text-destructive/70 mb-2" />
                  <p className="text-sm font-medium">Could not load attribute values</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-3 shrink-0"
                    onClick={() => void valuesQuery.refetch()}
                  >
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Retry
                  </Button>
                </div>
              ) : values.length > 0 ? (
                <div className="min-h-0 flex-1 overflow-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-background z-10">
                      <TableRow>
                        <TableHead className="bg-muted/50">Value</TableHead>
                        <TableHead className="text-center bg-muted/50 w-24">
                          Products
                        </TableHead>
                        <TableHead className="bg-muted/50 w-24 text-right sm:w-32">
                          Actions
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {values.map((item) => (
                        <TableRow key={item.value}>
                          <TableCell>
                            {editingValue === item.value ? (
                              <div className="flex min-w-32 flex-wrap items-center gap-2 sm:flex-nowrap">
                                <Input
                                  value={editedValue}
                                  aria-label={`New value for ${item.value}`}
                                  onChange={(e) =>
                                    setEditedValue(e.target.value)
                                  }
                                  className="h-8 min-w-0 basis-full sm:flex-1 sm:basis-auto"
                                  autoFocus
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      void handleSaveEdit();
                                    }
                                    if (e.key === "Escape") handleCancelEdit();
                                  }}
                                />
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8 shrink-0 text-green-600"
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
                                  className="h-8 w-8 shrink-0"
                                  onClick={handleCancelEdit}
                                  aria-label={`Cancel rename for ${item.value}`}
                                >
                                  <X className="h-4 w-4" />
                                </Button>
                              </div>
                            ) : (
                              <span className="font-medium [overflow-wrap:anywhere]">{item.value}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-center">
                            <div className="flex flex-wrap justify-center gap-1">
                              <Badge
                                variant={
                                  item.productCount > 0
                                    ? "secondary"
                                    : "outline"
                                }
                              >
                                {item.productCount}
                              </Badge>
                              {item.isPreset && (
                                <Badge
                                  variant="outline"
                                  className="border-primary/50 text-primary"
                                >
                                  Preset
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
                <div className="flex min-h-0 flex-1 flex-col items-center overflow-auto p-4 text-center [justify-content:safe_center]">
                  <Package className="h-10 w-10 shrink-0 opacity-40 mb-2" />
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
              <Button variant="outline" onClick={handleClose}>
                <X className="h-4 w-4 mr-2" />
                Close
              </Button>
            </div>
          </fieldset>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={!!deleteConfirm}
        onOpenChange={() => {
          if (!commandInFlight.current) setDeleteConfirm(null);
        }}
        title="Delete Value?"
        description={`This will remove the value "${deleteConfirm}" from all products using it. This action cannot be undone.`}
        confirmLabel="Delete"
        loadingLabel="Deleting..."
        isLoading={pending}
        variant="destructive"
        onConfirm={() => deleteConfirm && handleDelete(deleteConfirm)}
      />
    </>
  );
}
