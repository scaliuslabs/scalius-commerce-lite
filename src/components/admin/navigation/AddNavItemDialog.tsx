// src/components/admin/navigation/AddNavItemDialog.tsx
import { useState, useEffect, useCallback } from "react";
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
import { Badge } from "@/components/ui/badge";

import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FolderOpen,
  FileText,
  Sparkles,
  Link2,
  Type,
  Loader2,
  Search,
  Check,
  Plus,
  Trash2,
  Package,
} from "lucide-react";
import { nanoid } from "nanoid";
import { cn } from "@/lib/utils";
import type { NavigationItem, NavigationSource } from "./types";

type NavItemType = "category" | "page" | "dynamic" | "custom" | "label";

interface AttributeFilter {
  id: string;
  attributeId: string;
  attributeName: string;
  attributeSlug: string;
  value: string;
}

interface AddNavItemDialogProps {
  open: boolean;
  onClose: () => void;
  onAdd: (items: NavigationItem[]) => void;
  parentLabel?: string; // If adding to a parent, show which one
  getStorefrontPath: (path: string) => string;
}

export function AddNavItemDialog({
  open,
  onClose,
  onAdd,
  parentLabel,
  getStorefrontPath,
}: AddNavItemDialogProps) {
  const [activeType, setActiveType] = useState<NavItemType>("category");
  const [isLoading, setIsLoading] = useState(false);

  // Data sources
  const [categories, setCategories] = useState<NavigationSource[]>([]);
  const [pages, setPages] = useState<NavigationSource[]>([]);
  const [attributes, setAttributes] = useState<
    { id: string; name: string; slug: string }[]
  >([]);

  // Selection states
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(
    new Set(),
  );
  const [selectedPages, setSelectedPages] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");

  // Custom/Label states
  const [customLabel, setCustomLabel] = useState("");
  const [customUrl, setCustomUrl] = useState("");

  // Dynamic link states
  const [dynamicCategory, setDynamicCategory] = useState("");
  const [dynamicFilters, setDynamicFilters] = useState<AttributeFilter[]>([]);
  const [dynamicLabel, setDynamicLabel] = useState("");
  const [attributeValues, setAttributeValues] = useState<
    Record<string, { value: string; productCount: number }[]>
  >({});
  const [loadingAttrValues, setLoadingAttrValues] = useState<
    Record<string, boolean>
  >({});
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);

  // Fetch sources on open
  useEffect(() => {
    if (!open) return;

    const fetchData = async () => {
      setIsLoading(true);
      try {
        const [navRes, attrRes] = await Promise.all([
          fetch("/api/navigation/items"),
          fetch("/api/admin/attributes?limit=100"),
        ]);

        if (navRes.ok) {
          const data = await navRes.json();
          setCategories(data.items?.categories || []);
          setPages(data.items?.pages || []);
        }

        if (attrRes.ok) {
          const data = await attrRes.json();
          setAttributes(
            data.data
              ?.filter((a: any) => a.filterable !== false)
              .map((a: any) => ({
                id: a.id,
                name: a.name,
                slug: a.slug,
              })) || [],
          );
        }
      } catch (error) {
        console.error("Error fetching data:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [open]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setSelectedCategories(new Set());
      setSelectedPages(new Set());
      setSearchQuery("");
      setCustomLabel("");
      setCustomUrl("");
      setDynamicCategory("");
      setDynamicFilters([]);
      setDynamicLabel("");
      setPreviewCount(null);
    }
  }, [open]);

  // Fetch attribute values
  const fetchAttributeValues = useCallback(
    async (attributeId: string) => {
      if (attributeValues[attributeId]) return;

      setLoadingAttrValues((prev) => ({ ...prev, [attributeId]: true }));
      try {
        const res = await fetch(`/api/admin/attributes/${attributeId}/values`);
        if (res.ok) {
          const data = await res.json();
          setAttributeValues((prev) => ({
            ...prev,
            [attributeId]: data.values || [],
          }));
        }
      } catch (error) {
        console.error("Error fetching attribute values:", error);
      } finally {
        setLoadingAttrValues((prev) => ({ ...prev, [attributeId]: false }));
      }
    },
    [attributeValues],
  );

  // Fetch preview count for dynamic links
  useEffect(() => {
    if (!dynamicCategory) {
      setPreviewCount(null);
      return;
    }

    const fetchPreview = async () => {
      setIsLoadingPreview(true);
      try {
        const params = new URLSearchParams();
        params.set("categoryId", dynamicCategory);
        dynamicFilters.forEach((f) => {
          if (f.attributeSlug && f.value) {
            params.append(f.attributeSlug, f.value);
          }
        });

        const res = await fetch(
          `/api/admin/navigation/preview-products?${params.toString()}`,
        );
        if (res.ok) {
          const data = await res.json();
          setPreviewCount(data.count);
        }
      } catch (error) {
        console.error("Error fetching preview:", error);
      } finally {
        setIsLoadingPreview(false);
      }
    };

    const debounce = setTimeout(fetchPreview, 300);
    return () => clearTimeout(debounce);
  }, [dynamicCategory, dynamicFilters]);

  // Generate dynamic link URL
  const generateDynamicUrl = useCallback(() => {
    if (!dynamicCategory) return "";
    const category = categories.find((c) => c.id === dynamicCategory);
    if (!category) return "";

    const params = new URLSearchParams();
    params.set("page", "1");
    params.set("sortBy", "newest");

    dynamicFilters.forEach((f) => {
      if (f.attributeSlug && f.value) {
        params.append(f.attributeSlug, f.value);
      }
    });

    return `/categories/${category.slug}?${params.toString()}`;
  }, [dynamicCategory, categories, dynamicFilters]);

  // Filter items by search
  const filteredCategories = categories.filter((c) =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );
  const filteredPages = pages.filter((p) =>
    p.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  // Handle add
  const handleAdd = () => {
    const newItems: NavigationItem[] = [];

    if (activeType === "category") {
      selectedCategories.forEach((id) => {
        const cat = categories.find((c) => c.id === id);
        if (cat) {
          newItems.push({
            id: nanoid(),
            title: cat.name,
            href: cat.url,
            subMenu: [],
          });
        }
      });
    } else if (activeType === "page") {
      selectedPages.forEach((id) => {
        const page = pages.find((p) => p.id === id);
        if (page) {
          newItems.push({
            id: nanoid(),
            title: page.name,
            href: page.url,
            subMenu: [],
          });
        }
      });
    } else if (activeType === "dynamic") {
      const url = generateDynamicUrl();
      if (url && dynamicLabel.trim()) {
        newItems.push({
          id: nanoid(),
          title: dynamicLabel.trim(),
          href: url,
          subMenu: [],
        });
      }
    } else if (activeType === "custom") {
      if (customLabel.trim()) {
        newItems.push({
          id: nanoid(),
          title: customLabel.trim(),
          href: customUrl.trim() || undefined,
          subMenu: [],
        });
      }
    } else if (activeType === "label") {
      if (customLabel.trim()) {
        newItems.push({
          id: nanoid(),
          title: customLabel.trim(),
          href: undefined,
          subMenu: [],
        });
      }
    }

    if (newItems.length > 0) {
      onAdd(newItems);
      onClose();
    }
  };

  // Check if can add
  const canAdd = () => {
    if (activeType === "category") return selectedCategories.size > 0;
    if (activeType === "page") return selectedPages.size > 0;
    if (activeType === "dynamic") return dynamicCategory && dynamicLabel.trim();
    if (activeType === "custom") return customLabel.trim();
    if (activeType === "label") return customLabel.trim();
    return false;
  };

  const typeInfo = {
    category: { icon: FolderOpen, label: "Category", color: "text-blue-500" },
    page: { icon: FileText, label: "Page", color: "text-green-500" },
    dynamic: { icon: Sparkles, label: "Dynamic", color: "text-purple-500" },
    custom: { icon: Link2, label: "Custom Link", color: "text-orange-500" },
    label: { icon: Type, label: "Label Only", color: "text-gray-500" },
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0">
        <DialogHeader className="px-6 pt-6 pb-2">
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5" />
            Add Navigation Item
            {parentLabel && (
              <Badge variant="secondary" className="font-normal">
                to "{parentLabel}"
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            Choose the type of item and configure it
          </DialogDescription>
        </DialogHeader>

        {/* Type Selector */}
        <div className="px-6 py-3 border-b bg-muted/30">
          <div className="flex gap-2 overflow-x-auto">
            {(Object.keys(typeInfo) as NavItemType[]).map((type) => {
              const info = typeInfo[type];
              const Icon = info.icon;
              return (
                <Button
                  key={type}
                  variant={activeType === type ? "default" : "outline"}
                  size="sm"
                  onClick={() => setActiveType(type)}
                  className={cn(
                    "flex items-center gap-2 shrink-0",
                    activeType !== type && info.color,
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {info.label}
                </Button>
              );
            })}
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : (
            <>
              {/* Categories */}
              {activeType === "category" && (
                <div className="space-y-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search categories..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-9"
                    />
                  </div>

                  {filteredCategories.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                      <FolderOpen className="h-12 w-12 mx-auto mb-2 opacity-50" />
                      <p>No categories found</p>
                    </div>
                  ) : (
                    <ScrollArea className="h-[300px] border rounded-lg">
                      <div className="divide-y">
                        {filteredCategories.map((cat) => (
                          <div
                            key={cat.id}
                            className={cn(
                              "flex items-center gap-3 p-3 cursor-pointer hover:bg-muted/50 transition-colors",
                              selectedCategories.has(cat.id) && "bg-primary/10",
                            )}
                            onClick={() => {
                              setSelectedCategories((prev) => {
                                const next = new Set(prev);
                                if (next.has(cat.id)) next.delete(cat.id);
                                else next.add(cat.id);
                                return next;
                              });
                            }}
                          >
                            <Checkbox
                              checked={selectedCategories.has(cat.id)}
                              onCheckedChange={() => {}}
                            />
                            <div className="flex-1">
                              <div className="font-medium">{cat.name}</div>
                              <div className="text-xs text-muted-foreground">
                                {cat.url}
                              </div>
                            </div>
                            {selectedCategories.has(cat.id) && (
                              <Check className="h-4 w-4 text-primary" />
                            )}
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  )}

                  {selectedCategories.size > 0 && (
                    <div className="flex items-center justify-between p-2 bg-primary/10 rounded-lg">
                      <span className="text-sm font-medium">
                        {selectedCategories.size} selected
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedCategories(new Set())}
                      >
                        Clear
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {/* Pages */}
              {activeType === "page" && (
                <div className="space-y-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search pages..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-9"
                    />
                  </div>

                  {filteredPages.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                      <FileText className="h-12 w-12 mx-auto mb-2 opacity-50" />
                      <p>No pages found</p>
                    </div>
                  ) : (
                    <ScrollArea className="h-[300px] border rounded-lg">
                      <div className="divide-y">
                        {filteredPages.map((page) => (
                          <div
                            key={page.id}
                            className={cn(
                              "flex items-center gap-3 p-3 cursor-pointer hover:bg-muted/50 transition-colors",
                              selectedPages.has(page.id) && "bg-primary/10",
                            )}
                            onClick={() => {
                              setSelectedPages((prev) => {
                                const next = new Set(prev);
                                if (next.has(page.id)) next.delete(page.id);
                                else next.add(page.id);
                                return next;
                              });
                            }}
                          >
                            <Checkbox
                              checked={selectedPages.has(page.id)}
                              onCheckedChange={() => {}}
                            />
                            <div className="flex-1">
                              <div className="font-medium">{page.name}</div>
                              <div className="text-xs text-muted-foreground">
                                {page.url}
                              </div>
                            </div>
                            {selectedPages.has(page.id) && (
                              <Check className="h-4 w-4 text-primary" />
                            )}
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  )}

                  {selectedPages.size > 0 && (
                    <div className="flex items-center justify-between p-2 bg-primary/10 rounded-lg">
                      <span className="text-sm font-medium">
                        {selectedPages.size} selected
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedPages(new Set())}
                      >
                        Clear
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {/* Dynamic Link */}
              {activeType === "dynamic" && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Category</Label>
                    <Select
                      value={dynamicCategory}
                      onValueChange={setDynamicCategory}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select a category" />
                      </SelectTrigger>
                      <SelectContent>
                        {categories.map((cat) => (
                          <SelectItem key={cat.id} value={cat.id}>
                            {cat.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {dynamicCategory && (
                    <>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <Label>Attribute Filters</Label>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setDynamicFilters((prev) => [
                                ...prev,
                                {
                                  id: nanoid(),
                                  attributeId: "",
                                  attributeName: "",
                                  attributeSlug: "",
                                  value: "",
                                },
                              ]);
                            }}
                          >
                            <Plus className="h-3 w-3 mr-1" />
                            Add Filter
                          </Button>
                        </div>

                        {dynamicFilters.length === 0 ? (
                          <div className="text-sm text-muted-foreground p-4 border border-dashed rounded-lg text-center">
                            No filters. Add attribute filters to narrow down
                            products.
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {dynamicFilters.map((filter) => (
                              <div
                                key={filter.id}
                                className="flex items-center gap-2 p-2 border rounded-lg bg-muted/20"
                              >
                                <Select
                                  value={filter.attributeId}
                                  onValueChange={(val) => {
                                    const attr = attributes.find(
                                      (a) => a.id === val,
                                    );
                                    setDynamicFilters((prev) =>
                                      prev.map((f) =>
                                        f.id === filter.id
                                          ? {
                                              ...f,
                                              attributeId: val,
                                              attributeName: attr?.name || "",
                                              attributeSlug: attr?.slug || "",
                                              value: "",
                                            }
                                          : f,
                                      ),
                                    );
                                    if (val) fetchAttributeValues(val);
                                  }}
                                >
                                  <SelectTrigger className="w-[140px]">
                                    <SelectValue placeholder="Attribute" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {attributes.map((attr) => (
                                      <SelectItem key={attr.id} value={attr.id}>
                                        {attr.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>

                                <span className="text-muted-foreground">=</span>

                                {filter.attributeId ? (
                                  loadingAttrValues[filter.attributeId] ? (
                                    <div className="flex-1 flex items-center justify-center">
                                      <Loader2 className="h-4 w-4 animate-spin" />
                                    </div>
                                  ) : (
                                    <Select
                                      value={filter.value}
                                      onValueChange={(val) => {
                                        setDynamicFilters((prev) =>
                                          prev.map((f) =>
                                            f.id === filter.id
                                              ? { ...f, value: val }
                                              : f,
                                          ),
                                        );
                                      }}
                                    >
                                      <SelectTrigger className="flex-1">
                                        <SelectValue placeholder="Value" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {attributeValues[
                                          filter.attributeId
                                        ]?.map((v) => (
                                          <SelectItem
                                            key={v.value}
                                            value={v.value}
                                          >
                                            {v.value} ({v.productCount})
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  )
                                ) : (
                                  <Input
                                    placeholder="Select attribute first"
                                    disabled
                                    className="flex-1"
                                  />
                                )}

                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => {
                                    setDynamicFilters((prev) =>
                                      prev.filter((f) => f.id !== filter.id),
                                    );
                                  }}
                                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Preview */}
                      <div className="p-3 border rounded-lg bg-muted/10 space-y-2">
                        <div className="flex items-center justify-between">
                          <Label className="flex items-center gap-2">
                            <Package className="h-4 w-4" />
                            Preview
                          </Label>
                          {isLoadingPreview ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : previewCount !== null ? (
                            <Badge variant="secondary">
                              {previewCount} products
                            </Badge>
                          ) : null}
                        </div>
                        {generateDynamicUrl() && (
                          <code className="text-xs p-2 bg-muted rounded block overflow-x-auto">
                            {getStorefrontPath(generateDynamicUrl())}
                          </code>
                        )}
                      </div>

                      <div className="space-y-2">
                        <Label>Menu Label</Label>
                        <Input
                          value={dynamicLabel}
                          onChange={(e) => setDynamicLabel(e.target.value)}
                          placeholder="e.g., iPhone 15 Pro Max"
                        />
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Custom Link */}
              {activeType === "custom" && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Menu Label</Label>
                    <Input
                      value={customLabel}
                      onChange={(e) => setCustomLabel(e.target.value)}
                      placeholder="e.g., About Us"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>URL</Label>
                    <Input
                      value={customUrl}
                      onChange={(e) => setCustomUrl(e.target.value)}
                      placeholder="e.g., /about or https://example.com"
                    />
                  </div>
                </div>
              )}

              {/* Label Only */}
              {activeType === "label" && (
                <div className="space-y-4">
                  <div className="p-4 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                    <p className="text-sm text-amber-700 dark:text-amber-300">
                      Labels are non-clickable text items. They're useful as
                      dropdown headers that open child menus on hover.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>Label Text</Label>
                    <Input
                      value={customLabel}
                      onChange={(e) => setCustomLabel(e.target.value)}
                      placeholder="e.g., Shop by Category"
                    />
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <DialogFooter className="px-6 py-4 border-t">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleAdd} disabled={!canAdd()}>
            <Plus className="h-4 w-4 mr-2" />
            Add Item
            {(activeType === "category" && selectedCategories.size > 1) ||
            (activeType === "page" && selectedPages.size > 1)
              ? "s"
              : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
