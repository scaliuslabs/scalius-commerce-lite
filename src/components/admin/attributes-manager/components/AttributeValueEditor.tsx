// src/components/admin/attributes-manager/components/AttributeValueEditor.tsx
import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import {
  Loader2,
  Search,
  Edit3,
  Trash2,
  Check,
  X,
  Package,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import type { AttributeValue } from "../types";

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
  const [values, setValues] = useState<AttributeValue[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [editingValue, setEditingValue] = useState<string | null>(null);
  const [editedValue, setEditedValue] = useState("");
  const [savingValue, setSavingValue] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [newValue, setNewValue] = useState("");
  const [isAddingNew, setIsAddingNew] = useState(false);

  const fetchValues = useCallback(async () => {
    if (!attributeId) return;

    setIsLoading(true);
    try {
      const response = await fetch(
        `/api/admin/attributes/${attributeId}/values`,
      );
      if (!response.ok) throw new Error("Failed to fetch values");
      const data = await response.json();
      setValues(data.values || []);
    } catch (error) {
      console.error("Error fetching values:", error);
      toast.error("Failed to load attribute values");
    } finally {
      setIsLoading(false);
    }
  }, [attributeId]);

  useEffect(() => {
    if (attributeId) {
      fetchValues();
      setSearchQuery("");
      setEditingValue(null);
      setNewValue("");
      setIsAddingNew(false);
    }
  }, [attributeId, fetchValues]);

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
      const response = await fetch(
        `/api/admin/attributes/${attributeId}/values`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            oldValue: editingValue,
            newValue: editedValue.trim(),
          }),
        },
      );

      if (!response.ok) throw new Error("Failed to update value");

      toast.success(`Value renamed to "${editedValue.trim()}"`);
      setEditingValue(null);
      setEditedValue("");
      fetchValues();
    } catch (error) {
      console.error("Error updating value:", error);
      toast.error("Failed to update value");
    } finally {
      setSavingValue(null);
    }
  };

  const handleAddValue = async () => {
    if (!attributeId || !newValue.trim()) return;

    setSavingValue("new");
    try {
      const response = await fetch(
        `/api/admin/attributes/${attributeId}/values`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            value: newValue.trim(),
          }),
        },
      );

      if (!response.ok) throw new Error("Failed to add value");

      toast.success(`Value "${newValue.trim()}" added`);
      setNewValue("");
      setIsAddingNew(false);
      fetchValues();
    } catch (error) {
      console.error("Error adding value:", error);
      toast.error("Failed to add value");
    } finally {
      setSavingValue(null);
    }
  };

  const handleDelete = async (value: string) => {
    if (!attributeId) return;

    setSavingValue(value);
    try {
      const response = await fetch(
        `/api/admin/attributes/${attributeId}/values`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value }),
        },
      );

      if (!response.ok) throw new Error("Failed to delete value");

      toast.success(`Value "${value}" deleted from all products`);
      setDeleteConfirm(null);
      fetchValues();
    } catch (error) {
      console.error("Error deleting value:", error);
      toast.error("Failed to delete value");
    } finally {
      setSavingValue(null);
    }
  };

  const filteredValues = values.filter((v) =>
    v.value.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const totalProducts = values.reduce((sum, v) => sum + v.productCount, 0);

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
                  {isLoading ? "-" : values.length}
                </div>
              </div>
              <div className="flex-1 p-3 border rounded-lg">
                <div className="text-sm text-muted-foreground">
                  Total Products
                </div>
                <div className="text-2xl font-bold">
                  {isLoading ? "-" : totalProducts}
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
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                  disabled={isLoading}
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
                      disabled={!newValue.trim() || savingValue !== null}
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
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <Button onClick={() => setIsAddingNew(true)}>
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
              ) : filteredValues.length > 0 ? (
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
                      {filteredValues.map((item) => (
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
                                >
                                  <Edit3 className="h-4 w-4" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8 text-destructive hover:text-destructive"
                                  onClick={() => setDeleteConfirm(item.value)}
                                  disabled={savingValue !== null}
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
      <AlertDialog
        open={!!deleteConfirm}
        onOpenChange={() => setDeleteConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Value?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the value "{deleteConfirm}" from all products
              using it. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteConfirm && handleDelete(deleteConfirm)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
