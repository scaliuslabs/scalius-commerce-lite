// src/components/admin/navigation/AddNavItemDialog.tsx
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Badge } from "~/components/ui/badge";

import { Checkbox } from "~/components/ui/checkbox";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
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
  Layers3,
} from "lucide-react";
import { nanoid } from "nanoid";
import { cn } from "@scalius/shared/utils";
import { parseNavigationHref } from "@scalius/shared/navigation-href";
import type { NavigationItem, NavigationSource } from "./types";
import { getCategories } from "~/lib/api-functions/categories";
import {
  getAttributes,
  getAttributeValues,
} from "~/lib/api-functions/attributes";
import {
  getNavigationItems,
  getNavigationPreviewProducts,
  type NavigationPreviewProductsInput,
} from "~/lib/api-functions/navigation";

type NavItemType =
  | "category"
  | "page"
  | "product"
  | "collection"
  | "dynamic"
  | "custom"
  | "label";

const PAGE_SIZE = 10;

interface AttributeFilter {
  id: string;
  attributeId: string;
  attributeName: string;
  attributeSlug: string;
  value: string;
}

interface PaginatedState {
  items: NavigationSource[];
  total: number;
  page: number;
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  search: string;
}

const initialPaginatedState: PaginatedState = {
  items: [],
  total: 0,
  page: 1,
  hasMore: false,
  isLoading: false,
  isLoadingMore: false,
  search: "",
};

interface AddNavItemDialogProps {
  open: boolean;
  onClose: () => void;
  onAdd: (items: NavigationItem[]) => void;
  availableSlots?: number;
  parentLabel?: string; // If adding to a parent, show which one
  getStorefrontPath: (path: string) => string;
}

export function AddNavItemDialog({
  open,
  onClose,
  onAdd,
  availableSlots = Number.POSITIVE_INFINITY,
  parentLabel,
  getStorefrontPath,
}: AddNavItemDialogProps) {
  const [activeType, setActiveType] = useState<NavItemType>("category");
  const [isLoading, setIsLoading] = useState(false);

  // Paginated data sources
  const [catState, setCatState] = useState<PaginatedState>(initialPaginatedState);
  const [pageState, setPageState] = useState<PaginatedState>(initialPaginatedState);

  // All categories for the dynamic link dropdown (loaded from navigation items)
  const [allCategories, setAllCategories] = useState<NavigationSource[]>([]);
  const [attributes, setAttributes] = useState<
    { id: string; name: string; slug: string }[]
  >([]);

  // Selection states — store full item data so selections persist across pages/searches
  const [selectedCategoryMap, setSelectedCategoryMap] = useState<
    Map<string, NavigationSource>
  >(new Map());
  const [selectedPageMap, setSelectedPageMap] = useState<
    Map<string, NavigationSource>
  >(new Map());
  const [selectedProductMap, setSelectedProductMap] = useState<
    Map<string, NavigationSource>
  >(new Map());
  const [selectedCollectionMap, setSelectedCollectionMap] = useState<
    Map<string, NavigationSource>
  >(new Map());
  const [productSources, setProductSources] = useState<NavigationSource[]>([]);
  const [collectionSources, setCollectionSources] = useState<NavigationSource[]>([]);

  // Search input states (before debounce)
  const [catSearchInput, setCatSearchInput] = useState("");
  const [pageSearchInput, setPageSearchInput] = useState("");
  const [productSearchInput, setProductSearchInput] = useState("");
  const [collectionSearchInput, setCollectionSearchInput] = useState("");

  // Custom/Label states
  const [customLabel, setCustomLabel] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const customUrlResult = parseNavigationHref(customUrl);

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

  // Refs for debounce timers
  const catSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pageSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Fetch categories (paginated) ──────────────────────────────
  const fetchCategories = useCallback(
    async (search: string, page: number, append: boolean) => {
      if (append) {
        setCatState((prev) => ({ ...prev, isLoadingMore: true }));
      } else {
        setCatState((prev) => ({ ...prev, isLoading: true }));
      }

      try {
        const data = await getCategories({
          data: { page, limit: PAGE_SIZE, search: search || undefined },
        });

        const cats: NavigationSource[] = data.categories.map((c) => ({
          id: c.id,
          name: c.name,
          slug: c.slug,
          type: "category",
          url: `/categories/${c.slug}`,
        }));

        const pagination = data.pagination;

        setCatState((prev) => ({
          items: append ? [...prev.items, ...cats] : cats,
          total: pagination.total,
          page: pagination.page,
          hasMore: pagination.page < pagination.totalPages,
          isLoading: false,
          isLoadingMore: false,
          search,
        }));
      } catch (error: unknown) {
        if (import.meta.env.DEV) console.error("Error fetching categories:", error);
        setCatState((prev) => ({ ...prev, isLoading: false, isLoadingMore: false }));
      }
    },
    [],
  );

  // ── Fetch pages (paginated) ───────────────────────────────────
  const fetchPages = useCallback(
    async (search: string, page: number, append: boolean) => {
      if (append) {
        setPageState((prev) => ({ ...prev, isLoadingMore: true }));
      } else {
        setPageState((prev) => ({ ...prev, isLoading: true }));
      }

      try {
        const data = await getNavigationItems();
        const normalizedSearch = search.trim().toLowerCase();
        const matchingPages = (data.items.pages ?? []).filter((item) =>
          !normalizedSearch ||
          item.name.toLowerCase().includes(normalizedSearch) ||
          item.slug.toLowerCase().includes(normalizedSearch),
        );
        const offset = (page - 1) * PAGE_SIZE;
        const pgs = matchingPages.slice(offset, offset + PAGE_SIZE);

        setPageState((prev) => ({
          items: append ? [...prev.items, ...pgs] : pgs,
          total: matchingPages.length,
          page,
          hasMore: offset + pgs.length < matchingPages.length,
          isLoading: false,
          isLoadingMore: false,
          search,
        }));
      } catch (error: unknown) {
        if (import.meta.env.DEV) console.error("Error fetching pages:", error);
        setPageState((prev) => ({ ...prev, isLoading: false, isLoadingMore: false }));
      }
    },
    [],
  );

  // ── Debounced search for categories ───────────────────────────
  useEffect(() => {
    if (!open) return;
    if (catSearchTimerRef.current) clearTimeout(catSearchTimerRef.current);
    catSearchTimerRef.current = setTimeout(() => {
      fetchCategories(catSearchInput, 1, false);
    }, 300);
    return () => {
      if (catSearchTimerRef.current) clearTimeout(catSearchTimerRef.current);
    };
  }, [catSearchInput, open, fetchCategories]);

  // ── Debounced search for pages ────────────────────────────────
  useEffect(() => {
    if (!open) return;
    if (pageSearchTimerRef.current) clearTimeout(pageSearchTimerRef.current);
    pageSearchTimerRef.current = setTimeout(() => {
      fetchPages(pageSearchInput, 1, false);
    }, 300);
    return () => {
      if (pageSearchTimerRef.current) clearTimeout(pageSearchTimerRef.current);
    };
  }, [pageSearchInput, open, fetchPages]);

  // ── Fetch dynamic-link data on dialog open ────────────────────
  useEffect(() => {
    if (!open) return;

    const fetchData = async () => {
      setIsLoading(true);
      try {
        const [navData, attrData] = await Promise.all([
          getNavigationItems(),
          getAttributes({ data: { limit: 100 } }),
        ]);

        const items = navData.items;
        setAllCategories(items?.categories || []);
        setProductSources(items?.products || []);
        setCollectionSources(items?.collections || []);

        const attrs = attrData.attributes || [];
        setAttributes(
          attrs
            .filter((a) => a.filterable !== false)
            .map((a) => ({ id: a.id, name: a.name, slug: a.slug })),
        );
      } catch (error: unknown) {
        if (import.meta.env.DEV) console.error("Error fetching data:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [open]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setSelectedCategoryMap(new Map());
      setSelectedPageMap(new Map());
      setSelectedProductMap(new Map());
      setSelectedCollectionMap(new Map());
      setCatSearchInput("");
      setPageSearchInput("");
      setProductSearchInput("");
      setCollectionSearchInput("");
      setCatState(initialPaginatedState);
      setPageState(initialPaginatedState);
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
        const data = await getAttributeValues({
          data: { attributeId },
        });
        setAttributeValues((prev) => ({
          ...prev,
          [attributeId]: data.values || [],
        }));
      } catch (error: unknown) {
        if (import.meta.env.DEV) console.error("Error fetching attribute values:", error);
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
        const params: NavigationPreviewProductsInput = {
          categoryId: dynamicCategory,
        };
        dynamicFilters.forEach((f) => {
          if (f.attributeSlug && f.value) {
            params[f.attributeSlug] = f.value;
          }
        });

        const data = await getNavigationPreviewProducts({
          data: params,
        });
        setPreviewCount(data.count);
      } catch (error: unknown) {
        if (import.meta.env.DEV) console.error("Error fetching preview:", error);
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
    const category = allCategories.find((c) => c.id === dynamicCategory);
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
  }, [dynamicCategory, allCategories, dynamicFilters]);

  // ── Selection toggle helpers ──────────────────────────────────
  const toggleCategory = (cat: NavigationSource) => {
    setSelectedCategoryMap((prev) => {
      const next = new Map(prev);
      if (next.has(cat.id)) {
        next.delete(cat.id);
      } else if (next.size < availableSlots) {
        next.set(cat.id, cat);
      } else {
        return prev;
      }
      return next;
    });
  };

  const togglePage = (page: NavigationSource) => {
    setSelectedPageMap((prev) => {
      const next = new Map(prev);
      if (next.has(page.id)) {
        next.delete(page.id);
      } else if (next.size < availableSlots) {
        next.set(page.id, page);
      } else {
        return prev;
      }
      return next;
    });
  };

  const toggleResource = (
    resource: NavigationSource,
    setter: Dispatch<SetStateAction<Map<string, NavigationSource>>>,
  ) => {
    setter((previous) => {
      const next = new Map(previous);
      if (next.has(resource.id)) next.delete(resource.id);
      else if (next.size < availableSlots) next.set(resource.id, resource);
      return next;
    });
  };

  // Handle add
  const handleAdd = () => {
    const newItems: NavigationItem[] = [];

    if (activeType === "category") {
      selectedCategoryMap.forEach((cat) => {
        newItems.push({
          id: nanoid(),
          target: { type: "resource", resourceType: "category", resourceId: cat.id },
          labelMode: "resource",
          lastKnownLabel: cat.name,
          subMenu: [],
        });
      });
    } else if (activeType === "page") {
      selectedPageMap.forEach((page) => {
        newItems.push({
          id: nanoid(),
          target: { type: "resource", resourceType: "page", resourceId: page.id },
          labelMode: "resource",
          lastKnownLabel: page.name,
          subMenu: [],
        });
      });
    } else if (activeType === "product" || activeType === "collection") {
      const sourceMap = activeType === "product"
        ? selectedProductMap
        : selectedCollectionMap;
      sourceMap.forEach((resource) => {
        newItems.push({
          id: nanoid(),
          target: {
            type: "resource",
            resourceType: activeType,
            resourceId: resource.id,
          },
          labelMode: "resource",
          lastKnownLabel: resource.name,
          subMenu: [],
        });
      });
    } else if (activeType === "dynamic") {
      const category = allCategories.find((item) => item.id === dynamicCategory);
      const generatedUrl = generateDynamicUrl();
      const query = generatedUrl.includes("?")
        ? `?${generatedUrl.split("?")[1]}`
        : undefined;
      if (category && dynamicLabel.trim()) {
        newItems.push({
          id: nanoid(),
          target: {
            type: "resource",
            resourceType: "category",
            resourceId: category.id,
            ...(query ? { query } : {}),
          },
          labelMode: "custom",
          customLabel: dynamicLabel.trim(),
          lastKnownLabel: category.name,
          subMenu: [],
        });
      }
    } else if (activeType === "custom") {
      if (customLabel.trim() && customUrlResult.ok && customUrlResult.href) {
        newItems.push({
          id: nanoid(),
          target: customUrlResult.kind === "external"
            ? { type: "external_url", url: customUrlResult.href! }
            : { type: "internal_path", path: customUrlResult.href! },
          labelMode: "custom",
          customLabel: customLabel.trim(),
          subMenu: [],
        });
      }
    } else if (activeType === "label") {
      if (customLabel.trim()) {
        newItems.push({
          id: nanoid(),
          target: { type: "label" },
          labelMode: "custom",
          customLabel: customLabel.trim(),
          subMenu: [],
        });
      }
    }

    if (newItems.length > 0 && newItems.length <= availableSlots) {
      onAdd(newItems);
      onClose();
    }
  };

  // Check if can add
  const canAdd = () => {
    if (availableSlots < 1) return false;
    if (activeType === "category") {
      return selectedCategoryMap.size > 0 && selectedCategoryMap.size <= availableSlots;
    }
    if (activeType === "page") {
      return selectedPageMap.size > 0 && selectedPageMap.size <= availableSlots;
    }
    if (activeType === "product") {
      return selectedProductMap.size > 0 && selectedProductMap.size <= availableSlots;
    }
    if (activeType === "collection") {
      return selectedCollectionMap.size > 0 && selectedCollectionMap.size <= availableSlots;
    }
    if (activeType === "dynamic") return Boolean(dynamicCategory && dynamicLabel.trim());
    if (activeType === "custom") {
      return Boolean(customLabel.trim() && customUrlResult.ok && customUrlResult.href);
    }
    if (activeType === "label") return Boolean(customLabel.trim());
    return false;
  };

  const typeInfo = {
    category: {
      icon: FolderOpen,
      label: "Category",
      color: "text-blue-500",
    },
    page: { icon: FileText, label: "Page", color: "text-green-500" },
    product: { icon: Package, label: "Product", color: "text-rose-500" },
    collection: { icon: Layers3, label: "Collection", color: "text-cyan-500" },
    dynamic: { icon: Sparkles, label: "Dynamic", color: "text-purple-500" },
    custom: { icon: Link2, label: "Custom Link", color: "text-orange-500" },
    label: { icon: Type, label: "Label Only", color: "text-gray-500" },
  };
  const isCatalogResource = activeType === "product" || activeType === "collection";
  const catalogSources = activeType === "product" ? productSources : collectionSources;
  const catalogSearch = activeType === "product" ? productSearchInput : collectionSearchInput;
  const setCatalogSearch = activeType === "product"
    ? setProductSearchInput
    : setCollectionSearchInput;
  const selectedCatalogMap = activeType === "product"
    ? selectedProductMap
    : selectedCollectionMap;
  const setSelectedCatalogMap = activeType === "product"
    ? setSelectedProductMap
    : setSelectedCollectionMap;
  const normalizedCatalogSearch = catalogSearch.trim().toLocaleLowerCase();
  const filteredCatalogSources = catalogSources.filter((source) => (
    !normalizedCatalogSearch ||
    source.name.toLocaleLowerCase().includes(normalizedCatalogSearch) ||
    source.slug.toLocaleLowerCase().includes(normalizedCatalogSearch)
  ));

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
            Choose what to add. {Number.isFinite(availableSlots)
              ? `${availableSlots} ${availableSlots === 1 ? "space" : "spaces"} remaining in this menu.`
              : "You can add several published resources at once."}
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
          {isLoading && activeType === "dynamic" ? (
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
                      value={catSearchInput}
                      onChange={(e) => setCatSearchInput(e.target.value)}
                      className="pl-9"
                    />
                  </div>

                  {catState.isLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="h-8 w-8 animate-spin text-primary" />
                    </div>
                  ) : catState.items.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                      <FolderOpen className="h-12 w-12 mx-auto mb-2 opacity-50" />
                      <p>No categories found</p>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>
                          Showing {catState.items.length} of {catState.total}{" "}
                          {catState.total === 1 ? "category" : "categories"}
                        </span>
                      </div>

                      <ScrollArea className="h-[300px] border rounded-lg">
                        <div className="divide-y">
                          {catState.items.map((cat) => (
                            <div
                              key={cat.id}
                              className={cn(
                                "flex items-center gap-3 p-3 hover:bg-muted/50 transition-colors",
                                selectedCategoryMap.has(cat.id) &&
                                  "bg-primary/10",
                              )}
                            >
                              <Checkbox
                                id={`navigation-category-${cat.id}`}
                                checked={selectedCategoryMap.has(cat.id)}
                                disabled={
                                  !selectedCategoryMap.has(cat.id) &&
                                  selectedCategoryMap.size >= availableSlots
                                }
                                onCheckedChange={() => toggleCategory(cat)}
                              />
                              <label
                                htmlFor={`navigation-category-${cat.id}`}
                                className="min-w-0 flex-1 cursor-pointer"
                              >
                                <div className="font-medium">{cat.name}</div>
                                <div className="text-xs text-muted-foreground">
                                  {cat.url}
                                </div>
                              </label>
                              {selectedCategoryMap.has(cat.id) && (
                                <Check className="h-4 w-4 text-primary" />
                              )}
                            </div>
                          ))}

                          {catState.hasMore && (
                            <div className="p-3 flex justify-center">
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={catState.isLoadingMore}
                                onClick={() =>
                                  fetchCategories(
                                    catState.search,
                                    catState.page + 1,
                                    true,
                                  )
                                }
                              >
                                {catState.isLoadingMore ? (
                                  <>
                                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                                    Loading...
                                  </>
                                ) : (
                                  "Load More"
                                )}
                              </Button>
                            </div>
                          )}
                        </div>
                      </ScrollArea>
                    </>
                  )}

                  {selectedCategoryMap.size > 0 && (
                    <div className="flex items-center justify-between p-2 bg-primary/10 rounded-lg">
                      <span className="text-sm font-medium">
                        {selectedCategoryMap.size} selected
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedCategoryMap(new Map())}
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
                      value={pageSearchInput}
                      onChange={(e) => setPageSearchInput(e.target.value)}
                      className="pl-9"
                    />
                  </div>

                  {pageState.isLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="h-8 w-8 animate-spin text-primary" />
                    </div>
                  ) : pageState.items.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                      <FileText className="h-12 w-12 mx-auto mb-2 opacity-50" />
                      <p>No pages found</p>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>
                          Showing {pageState.items.length} of {pageState.total}{" "}
                          {pageState.total === 1 ? "page" : "pages"}
                        </span>
                      </div>

                      <ScrollArea className="h-[300px] border rounded-lg">
                        <div className="divide-y">
                          {pageState.items.map((page) => (
                            <div
                              key={page.id}
                              className={cn(
                                "flex items-center gap-3 p-3 hover:bg-muted/50 transition-colors",
                                selectedPageMap.has(page.id) && "bg-primary/10",
                              )}
                            >
                              <Checkbox
                                id={`navigation-page-${page.id}`}
                                checked={selectedPageMap.has(page.id)}
                                disabled={
                                  !selectedPageMap.has(page.id) &&
                                  selectedPageMap.size >= availableSlots
                                }
                                onCheckedChange={() => togglePage(page)}
                              />
                              <label
                                htmlFor={`navigation-page-${page.id}`}
                                className="min-w-0 flex-1 cursor-pointer"
                              >
                                <div className="font-medium">{page.name}</div>
                                <div className="text-xs text-muted-foreground">
                                  {page.url}
                                </div>
                              </label>
                              {selectedPageMap.has(page.id) && (
                                <Check className="h-4 w-4 text-primary" />
                              )}
                            </div>
                          ))}

                          {pageState.hasMore && (
                            <div className="p-3 flex justify-center">
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={pageState.isLoadingMore}
                                onClick={() =>
                                  fetchPages(
                                    pageState.search,
                                    pageState.page + 1,
                                    true,
                                  )
                                }
                              >
                                {pageState.isLoadingMore ? (
                                  <>
                                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                                    Loading...
                                  </>
                                ) : (
                                  "Load More"
                                )}
                              </Button>
                            </div>
                          )}
                        </div>
                      </ScrollArea>
                    </>
                  )}

                  {selectedPageMap.size > 0 && (
                    <div className="flex items-center justify-between p-2 bg-primary/10 rounded-lg">
                      <span className="text-sm font-medium">
                        {selectedPageMap.size} selected
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedPageMap(new Map())}
                      >
                        Clear
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {/* Products and collections are stable resource targets, not copied URLs. */}
              {isCatalogResource && (
                <div className="space-y-3">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder={`Search ${activeType === "product" ? "products" : "collections"}...`}
                      value={catalogSearch}
                      onChange={(event) => setCatalogSearch(event.target.value)}
                      className="pl-9"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    The menu will follow the current title and public route automatically.
                  </p>
                  <ScrollArea className="h-[300px] rounded-lg border">
                    {filteredCatalogSources.length === 0 ? (
                      <div className="grid h-48 place-items-center px-4 text-center text-sm text-muted-foreground">
                        No {activeType === "product" ? "products" : "collections"} found
                      </div>
                    ) : (
                      <div className="divide-y">
                        {filteredCatalogSources.map((resource) => {
                          const selected = selectedCatalogMap.has(resource.id);
                          return (
                            <label
                              key={resource.id}
                              htmlFor={`navigation-${activeType}-${resource.id}`}
                              className={cn(
                                "flex cursor-pointer items-center gap-3 p-3 transition-colors hover:bg-muted/50",
                                selected && "bg-primary/10",
                              )}
                            >
                              <Checkbox
                                id={`navigation-${activeType}-${resource.id}`}
                                checked={selected}
                                disabled={!selected && selectedCatalogMap.size >= availableSlots}
                                onCheckedChange={() => toggleResource(resource, setSelectedCatalogMap)}
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium">{resource.name}</span>
                                <span className="block truncate text-xs text-muted-foreground">
                                  {resource.url}
                                </span>
                              </span>
                              {selected ? <Check className="h-4 w-4 text-primary" /> : null}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </ScrollArea>
                  {selectedCatalogMap.size > 0 ? (
                    <div className="flex items-center justify-between rounded-lg bg-primary/10 p-2">
                      <span className="text-sm font-medium">
                        {selectedCatalogMap.size} selected
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedCatalogMap(new Map())}
                      >
                        Clear
                      </Button>
                    </div>
                  ) : null}
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
                        {allCategories.map((cat) => (
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
                      aria-invalid={!customUrlResult.ok}
                    />
                    {!customUrlResult.ok && (
                      <p className="text-xs text-destructive">
                        {customUrlResult.reason}
                      </p>
                    )}
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
            {(activeType === "category" && selectedCategoryMap.size > 1) ||
            (activeType === "page" && selectedPageMap.size > 1)
              ? "s"
              : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
