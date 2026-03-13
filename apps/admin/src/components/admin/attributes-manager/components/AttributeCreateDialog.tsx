// src/components/admin/attributes-manager/components/AttributeCreateDialog.tsx
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, X } from "lucide-react";
import type { AttributeCreateDialogProps } from "../types";

export function AttributeCreateDialog({
  open,
  newAttribute,
  isCreating,
  onOpenChange,
  onNameChange,
  onSlugChange,
  onFilterableChange,
  onOptionsChange,
  onCreate,
}: AttributeCreateDialogProps) {
  const [newOption, setNewOption] = useState("");

  const handleAddOption = () => {
    if (!newOption.trim()) return;
    const current = newAttribute.options || [];
    if (!current.includes(newOption.trim())) {
      onOptionsChange?.([...current, newOption.trim()]);
    }
    setNewOption("");
  };

  const handleRemoveOption = (option: string) => {
    const current = newAttribute.options || [];
    onOptionsChange?.(current.filter((o) => o !== option));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddOption();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[550px]">
        <DialogHeader>
          <DialogTitle>Create New Attribute</DialogTitle>
          <DialogDescription>
            Add a new product attribute with optional predefined values.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="attr-name">
                Attribute Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="attr-name"
                placeholder="e.g., Brand, Color, Size"
                value={newAttribute.name}
                onChange={onNameChange}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="attr-slug">
                Slug <span className="text-destructive">*</span>
              </Label>
              <Input
                id="attr-slug"
                placeholder="e.g., brand, color"
                value={newAttribute.slug}
                onChange={(e) => onSlugChange(e.target.value)}
                className="font-mono text-sm"
              />
            </div>
          </div>

          {/* Options */}
          <div className="space-y-2">
            <Label>Predefined Values (Optional)</Label>
            <div className="flex gap-2">
              <Input
                placeholder="Add a value (e.g., Red, XL, Apple)"
                value={newOption}
                onChange={(e) => setNewOption(e.target.value)}
                onKeyDown={handleKeyDown}
              />
              <Button
                type="button"
                variant="outline"
                onClick={handleAddOption}
                disabled={!newOption.trim()}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            {newAttribute.options && newAttribute.options.length > 0 && (
              <div className="flex flex-wrap gap-1.5 p-3 border rounded-lg bg-muted/20 max-h-[120px] overflow-y-auto">
                {newAttribute.options.map((option) => (
                  <Badge
                    key={option}
                    variant="secondary"
                    className="gap-1 pr-1"
                  >
                    {option}
                    <button
                      type="button"
                      onClick={() => handleRemoveOption(option)}
                      className="ml-1 hover:bg-muted rounded-full p-0.5"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Define available values for quick selection when adding to
              products.
            </p>
          </div>

          {/* Filterable */}
          <div className="flex items-center justify-between p-3 border rounded-lg">
            <div className="space-y-0.5">
              <Label htmlFor="attr-filterable" className="font-medium">
                Make Filterable
              </Label>
              <p className="text-xs text-muted-foreground">
                Allow customers to filter products by this attribute
              </p>
            </div>
            <Switch
              id="attr-filterable"
              checked={newAttribute.filterable}
              onCheckedChange={onFilterableChange}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={onCreate}
            disabled={
              isCreating ||
              !newAttribute.name.trim() ||
              !newAttribute.slug.trim()
            }
          >
            {isCreating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Creating...
              </>
            ) : (
              <>
                <Plus className="h-4 w-4 mr-2" />
                Create Attribute
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
