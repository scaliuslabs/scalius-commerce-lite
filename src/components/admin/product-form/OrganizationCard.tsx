// src/components/admin/product-form/OrganizationCard.tsx
import { useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronsUpDown, Check, Plus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { ProductFormValues } from "./types";

export interface Category {
  id: string;
  name: string;
}

interface OrganizationCardProps {
  form: UseFormReturn<ProductFormValues>;
  categories: Category[];
  isEdit?: boolean;
}

export function OrganizationCard({
  form,
  categories,
  isEdit,
}: OrganizationCardProps) {
  const [availableCategories, setAvailableCategories] = useState<Category[]>(categories);

  const handleCategoryCreated = (newCategory: Category) => {
    setAvailableCategories((prev) => [...prev, newCategory]);
    form.setValue("categoryId", newCategory.id, {
      shouldDirty: true,
      shouldValidate: true,
    });
  };

  return (
    <Card>
      <CardHeader className="pb-3 pt-4 px-4">
        <CardTitle className="text-base">Product Organization</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        <FormField
          control={form.control}
          name="categoryId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Category <span className="text-destructive">*</span>
              </FormLabel>
              <CategoryCombobox
                availableCategories={availableCategories}
                selectedCategoryId={field.value}
                onSelect={(categoryId) => {
                  field.onChange(categoryId);
                }}
                onCategoryCreated={handleCategoryCreated}
              />
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="slug"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                URL Slug <span className="text-destructive">*</span>
                {!isEdit && <span className="text-xs text-muted-foreground ml-1">(Auto-generated)</span>}
              </FormLabel>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  /products/
                </span>
                <FormControl>
                  <Input
                    placeholder="product-url-slug"
                    {...field}
                    onChange={(e) => {
                      field.onChange(e);
                      form.setValue("slugEdited", true);
                    }}
                  />
                </FormControl>
              </div>
              <FormDescription className="text-xs">
                {!isEdit
                  ? "Auto-generated from product name. You can edit it if needed."
                  : "The URL-friendly identifier for this product"}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </CardContent>
    </Card>
  );
}

// Combobox component for selecting and creating categories
function CategoryCombobox({
  availableCategories,
  selectedCategoryId,
  onSelect,
  onCategoryCreated,
}: {
  availableCategories: Category[];
  selectedCategoryId: string;
  onSelect: (categoryId: string) => void;
  onCategoryCreated: (newCategory: Category) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const handleCreate = async () => {
    if (!search.trim()) return;
    setIsCreating(true);

    // Generate slug from name
    const slug = search
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");

    try {
      const response = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: search.trim(),
          slug,
          description: null,
          metaTitle: null,
          metaDescription: null,
          image: null,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to create category");
      }

      const newCategory: Category = {
        id: data.id,
        name: search.trim(),
      };

      toast.success(`Category "${newCategory.name}" created successfully`);
      onCategoryCreated(newCategory);
      setOpen(false);
      setSearch("");
    } catch (error: any) {
      toast.error(error.message || "Failed to create category");
    } finally {
      setIsCreating(false);
    }
  };

  const selectedCategoryName =
    availableCategories.find((c) => c.id === selectedCategoryId)?.name ||
    "Select category...";

  const filteredCategories = availableCategories.filter((cat) =>
    cat.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          className={cn(
            "w-full justify-between h-10 font-normal",
            !selectedCategoryId && "text-muted-foreground"
          )}
        >
          <span className="truncate">{selectedCategoryName}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search categories..."
            value={search}
            onValueChange={setSearch}
            className="h-10"
          />
          <CommandList>
            {filteredCategories.length > 0 && (
              <CommandGroup heading="Categories" className="p-2">
                {filteredCategories.map((category) => (
                  <CommandItem
                    key={category.id}
                    value={category.name}
                    onSelect={() => {
                      onSelect(category.id);
                      setOpen(false);
                      setSearch("");
                    }}
                    className="px-2 py-2 cursor-pointer"
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        selectedCategoryId === category.id
                          ? "opacity-100"
                          : "opacity-0",
                      )}
                    />
                    <span className="flex-1">{category.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandEmpty>
              <div className="p-2">
                {search.trim() ? (
                  <Button
                    variant="ghost"
                    className="w-full justify-start h-auto py-3 px-2 hover:bg-accent"
                    onClick={handleCreate}
                    disabled={isCreating}
                  >
                    <div className="flex items-center w-full">
                      {isCreating ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin text-primary" />
                      ) : (
                        <Plus className="mr-2 h-4 w-4 text-primary" />
                      )}
                      <div className="flex-1 text-left">
                        <div className="text-sm font-medium">Create new category</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          Add "{search}"
                        </div>
                      </div>
                    </div>
                  </Button>
                ) : (
                  <div className="py-6 text-center">
                    <p className="text-sm text-muted-foreground">
                      Type to search or create a category
                    </p>
                  </div>
                )}
              </div>
            </CommandEmpty>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
