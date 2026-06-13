
import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { useDebounce } from '@/hooks/use-debounce';
import type { Category } from '@/types/api-responses';
import type { MediaFile, ProductSearchResult } from './types';
import { getProducts } from "@/lib/api-functions/products";
import {
  getCategories,
  type CategoryListItemDto,
} from "@/lib/api-functions/categories";
import {
  AI_CONTEXT_LIMITS,
  appendUniqueWithinLimit,
  uniqueByLimit,
} from "./ai-context-limits";
import {
  toSelectableProducts,
  type RawProduct,
} from "./ai-product-selector";

const PAGE_SIZE = 10;

function toDate(value: string | number | null): Date | null {
  if (value == null) return null;
  return new Date(typeof value === "number" && value < 1_000_000_000_000 ? value * 1000 : value);
}

function toWidgetCategory(category: CategoryListItemDto): Category {
  return {
    ...category,
    createdAt: toDate(category.createdAt) ?? new Date(0),
    updatedAt: toDate(category.updatedAt) ?? new Date(0),
    deletedAt: toDate(category.deletedAt),
  };
}

interface AiContextSelection {
  images?: MediaFile[];
  products?: ProductSearchResult[];
  categories?: Category[];
  allCategories?: boolean;
}

export const useAiContext = (
  initialContext?: AiContextSelection,
) => {
  const [selectedImages, setSelectedImages] = useState<MediaFile[]>(() =>
    uniqueByLimit(initialContext?.images ?? [], (image) => image.url, AI_CONTEXT_LIMITS.maxImages),
  );
  const [selectedProducts, setSelectedProducts] = useState<ProductSearchResult[]>(() =>
    uniqueByLimit(initialContext?.products ?? [], (product) => product.id, AI_CONTEXT_LIMITS.maxProducts),
  );
  const [selectedCategories, setSelectedCategories] = useState<Category[]>(() =>
    uniqueByLimit(initialContext?.categories ?? [], (category) => category.id, AI_CONTEXT_LIMITS.maxCategories),
  );
  const [allCategoriesSelected, setAllCategoriesSelected] = useState(initialContext?.allCategories || false);
  const productBrowseRequestId = useRef(0);
  const productSearchRequestId = useRef(0);
  const categoryRequestId = useRef(0);
  const pendingProductRequests = useRef(0);
  const pendingCategoryRequests = useRef(0);

  // Products state
  const [productSearchQuery, setProductSearchQuery] = useState("");
  const [productSearchResults, setProductSearchResults] = useState<ProductSearchResult[]>([]);
  const [latestProducts, setLatestProducts] = useState<ProductSearchResult[]>([]);
  const [productPage, setProductPage] = useState(1);
  const [productSearchPage, setProductSearchPage] = useState(1);
  const [hasMoreProducts, setHasMoreProducts] = useState(true);
  const [hasMoreSearchProducts, setHasMoreSearchProducts] = useState(false);
  const [isFetchingProducts, setIsFetchingProducts] = useState(false);
  const [isProductPopoverOpen, setIsProductPopoverOpen] = useState(false);
  const debouncedProductSearch = useDebounce(productSearchQuery, 300);

  // Categories state
  const [allCategoriesList, setAllCategoriesList] = useState<Category[]>([]);
  const [categorySearchQuery, setCategorySearchQuery] = useState("");
  const [categoryPage, setCategoryPage] = useState(1);
  const [hasMoreCategories, setHasMoreCategories] = useState(true);
  const [isFetchingCategories, setIsFetchingCategories] = useState(false);
  const [isCategoryPopoverOpen, setIsCategoryPopoverOpen] = useState(false);
  const debouncedCategorySearch = useDebounce(categorySearchQuery, 300);

  const setProductPopoverOpen = useCallback((open: boolean) => {
    setIsProductPopoverOpen(open);
    if (!open) {
      setProductSearchQuery("");
    }
  }, []);

  const setCategoryPopoverOpen = useCallback((open: boolean) => {
    setIsCategoryPopoverOpen(open);
    if (!open) {
      setCategorySearchQuery("");
    }
  }, []);

  const startProductRequest = useCallback(() => {
    pendingProductRequests.current += 1;
    setIsFetchingProducts(true);
  }, []);

  const finishProductRequest = useCallback(() => {
    pendingProductRequests.current = Math.max(0, pendingProductRequests.current - 1);
    setIsFetchingProducts(pendingProductRequests.current > 0);
  }, []);

  const startCategoryRequest = useCallback(() => {
    pendingCategoryRequests.current += 1;
    setIsFetchingCategories(true);
  }, []);

  const finishCategoryRequest = useCallback(() => {
    pendingCategoryRequests.current = Math.max(0, pendingCategoryRequests.current - 1);
    setIsFetchingCategories(pendingCategoryRequests.current > 0);
  }, []);

  // ─── Products: browse (no search) ───────────────────────────────────
  const fetchProductsForSelector = useCallback(async (pageToFetch: number) => {
    const requestId = ++productBrowseRequestId.current;
    startProductRequest();
    try {
      const data = await getProducts({
        data: { page: pageToFetch, limit: PAGE_SIZE, sort: "updatedAt", order: "desc" },
      });
      if (requestId !== productBrowseRequestId.current) return;

      const newProducts = toSelectableProducts(
        data.products as RawProduct[],
      );
      setLatestProducts((prev) => pageToFetch === 1 ? newProducts : [...prev, ...newProducts]);
      setProductPage(pageToFetch);
      setHasMoreProducts(data.pagination.totalPages > pageToFetch);
    } catch (error: unknown) {
      if (import.meta.env.DEV) console.error("Failed to fetch latest products:", error);
      toast.error("Could not load products.");
    } finally {
      finishProductRequest();
    }
  }, [finishProductRequest, startProductRequest]);

  // ─── Products: search with pagination ───────────────────────────────
  const fetchSearchProducts = useCallback(async (query: string, pageToFetch: number) => {
    const normalizedQuery = query.trim();
    const requestId = ++productSearchRequestId.current;
    startProductRequest();
    try {
      const data = await getProducts({
        data: { search: normalizedQuery, page: pageToFetch, limit: PAGE_SIZE },
      });
      if (requestId !== productSearchRequestId.current) return;

      const newProducts = toSelectableProducts(
        data.products as RawProduct[],
      );
      setProductSearchResults((prev) => pageToFetch === 1 ? newProducts : [...prev, ...newProducts]);
      setProductSearchPage(pageToFetch);
      setHasMoreSearchProducts(data.pagination.totalPages > pageToFetch);
    } catch (error) {
      if (import.meta.env.DEV) console.error("Failed to search products:", error);
    } finally {
      finishProductRequest();
    }
  }, [finishProductRequest, startProductRequest]);

  const loadMoreProducts = useCallback(() => {
    if (isFetchingProducts) return;
    if (debouncedProductSearch.trim()) {
      fetchSearchProducts(debouncedProductSearch, productSearchPage + 1);
    } else {
      fetchProductsForSelector(productPage + 1);
    }
  }, [debouncedProductSearch, productSearchPage, productPage, fetchSearchProducts, fetchProductsForSelector, isFetchingProducts]);

  useEffect(() => {
    if (isProductPopoverOpen && latestProducts.length === 0) {
      fetchProductsForSelector(1);
    }
  }, [isProductPopoverOpen, latestProducts.length, fetchProductsForSelector]);

  useEffect(() => {
    if (debouncedProductSearch.trim()) {
      setProductSearchResults([]);
      setProductSearchPage(1);
      setHasMoreSearchProducts(false);
      fetchSearchProducts(debouncedProductSearch, 1);
    } else {
      productSearchRequestId.current += 1;
      setProductSearchResults([]);
      setProductSearchPage(1);
      setHasMoreSearchProducts(false);
    }
  }, [debouncedProductSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Categories: paginated fetch ────────────────────────────────────
  const fetchCategoriesPage = useCallback(async (pageToFetch: number, search?: string) => {
    const normalizedSearch = search?.trim() || undefined;
    const requestId = ++categoryRequestId.current;
    startCategoryRequest();
    try {
      const params: { page: number; limit: number; search?: string } = {
        page: pageToFetch,
        limit: PAGE_SIZE,
      };
      if (normalizedSearch) params.search = normalizedSearch;
      const data = await getCategories({ data: params });
      if (requestId !== categoryRequestId.current) return;

      const newCategories = data.categories.map(toWidgetCategory);
      setAllCategoriesList((prev) => pageToFetch === 1 ? newCategories : [...prev, ...newCategories]);
      setCategoryPage(pageToFetch);
      const pagination = data.pagination;
      if (pagination) {
        setHasMoreCategories(pagination.totalPages > pageToFetch);
      } else {
        // If no pagination info, assume no more if fewer than PAGE_SIZE returned
        setHasMoreCategories(newCategories.length >= PAGE_SIZE);
      }
    } catch (error) {
      if (import.meta.env.DEV) console.error("Failed to fetch categories:", error);
    } finally {
      finishCategoryRequest();
    }
  }, [finishCategoryRequest, startCategoryRequest]);

  const loadMoreCategories = useCallback(() => {
    if (isFetchingCategories) return;
    const search = debouncedCategorySearch.trim() || undefined;
    fetchCategoriesPage(categoryPage + 1, search);
  }, [categoryPage, debouncedCategorySearch, fetchCategoriesPage, isFetchingCategories]);

  // Category search effect
  useEffect(() => {
    if (!isCategoryPopoverOpen) {
      categoryRequestId.current += 1;
      return;
    }

    setAllCategoriesList([]);
    setCategoryPage(1);
    setHasMoreCategories(true);
    const search = debouncedCategorySearch.trim() || undefined;
    fetchCategoriesPage(1, search);
  }, [debouncedCategorySearch, isCategoryPopoverOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Image handlers ─────────────────────────────────────────────────
  const handleImageSelect = (file: MediaFile) => {
    if (selectedImages.some((img) => img.url === file.url)) return;
    if (selectedImages.length >= AI_CONTEXT_LIMITS.maxImages) {
      toast.error(`Widget AI can use up to ${AI_CONTEXT_LIMITS.maxImages} images.`);
      return;
    }
    setSelectedImages((prev) => [...prev, file]);
  };

  const handleMultiImageSelect = (files: MediaFile[]) => {
    const result = appendUniqueWithinLimit(
      selectedImages,
      files,
      (file) => file.url,
      AI_CONTEXT_LIMITS.maxImages,
    );
    setSelectedImages(result.next);
    if (result.skipped > 0) {
      toast.error(`Skipped ${result.skipped} image${result.skipped === 1 ? "" : "s"} over the ${AI_CONTEXT_LIMITS.maxImages}-image limit.`);
    }
  };

  const removeImage = (imageUrl: string) => {
    setSelectedImages((prev) => prev.filter((img) => img.url !== imageUrl));
  };

  // ─── Product handlers ──────────────────────────────────────────────
  const handleProductSelect = (product: ProductSearchResult) => {
    if (selectedProducts.some((p) => p.id === product.id)) {
      removeProduct(product.id);
      return;
    }
    if (selectedProducts.length >= AI_CONTEXT_LIMITS.maxProducts) {
      toast.error(`Widget AI can use up to ${AI_CONTEXT_LIMITS.maxProducts} products.`);
      return;
    }
    setSelectedProducts((prev) => [...prev, product]);
  };

  const removeProduct = (productId: string) => {
    setSelectedProducts((prev) => prev.filter((p) => p.id !== productId));
  };

  // ─── Category handlers ─────────────────────────────────────────────
  const handleCategorySelect = (category: Category) => {
    if (selectedCategories.some((c) => c.id === category.id)) {
      removeCategory(category.id);
      return;
    }
    if (selectedCategories.length >= AI_CONTEXT_LIMITS.maxCategories) {
      toast.error(`Widget AI can use up to ${AI_CONTEXT_LIMITS.maxCategories} categories.`);
      return;
    }
    setSelectedCategories((prev) => [...prev, category]);
  };

  const removeCategory = (categoryId: string) => {
    setSelectedCategories((prev) => prev.filter((c) => c.id !== categoryId));
  };

  const handleToggleAllCategories = (checked: boolean) => {
    setAllCategoriesSelected(checked);
    if (checked) {
      setSelectedCategories([]);
    }
  };

  const replaceContext = useCallback((context: AiContextSelection = {}) => {
    const nextImages = uniqueByLimit(context.images ?? [], (image) => image.url, AI_CONTEXT_LIMITS.maxImages);
    const nextProducts = uniqueByLimit(context.products ?? [], (product) => product.id, AI_CONTEXT_LIMITS.maxProducts);
    const nextCategories = context.allCategories
      ? []
      : uniqueByLimit(context.categories ?? [], (category) => category.id, AI_CONTEXT_LIMITS.maxCategories);

    if (
      nextImages.length < (context.images?.length ?? 0) ||
      nextProducts.length < (context.products?.length ?? 0) ||
      nextCategories.length < (context.allCategories ? 0 : context.categories?.length ?? 0)
    ) {
      toast.warning("Saved AI context was trimmed to current widget limits.");
    }

    setSelectedImages(nextImages);
    setSelectedProducts(nextProducts);
    setSelectedCategories(nextCategories);
    setAllCategoriesSelected(Boolean(context.allCategories));
  }, []);

  const resetContext = useCallback(() => {
    replaceContext();
  }, [replaceContext]);

  // ─── Derived state ─────────────────────────────────────────────────
  const productsToShow = debouncedProductSearch.trim() ? productSearchResults : latestProducts;
  const currentHasMoreProducts = debouncedProductSearch.trim() ? hasMoreSearchProducts : hasMoreProducts;
  const currentProductPage = debouncedProductSearch.trim() ? productSearchPage : productPage;

  return {
    selectedImages,
    selectedProducts,
    selectedCategories,
    allCategoriesSelected,
    handleImageSelect,
    handleMultiImageSelect,
    removeImage,
    handleProductSelect,
    removeProduct,
    handleCategorySelect,
    removeCategory,
    handleToggleAllCategories,
    replaceContext,
    resetContext,
    allCategoriesList,
    isProductPopoverOpen,
    setIsProductPopoverOpen: setProductPopoverOpen,
    productSearchQuery,
    setProductSearchQuery,
    isFetchingProducts,
    productsToShow,
    debouncedProductSearch,
    hasMoreProducts: currentHasMoreProducts,
    fetchProductsForSelector,
    productPage: currentProductPage,
    loadMoreProducts,
    // Category pagination
    categorySearchQuery,
    setCategorySearchQuery,
    isCategoryPopoverOpen,
    setIsCategoryPopoverOpen: setCategoryPopoverOpen,
    hasMoreCategories,
    loadMoreCategories,
    isFetchingCategories,
    maxImages: AI_CONTEXT_LIMITS.maxImages,
    maxProducts: AI_CONTEXT_LIMITS.maxProducts,
    maxCategories: AI_CONTEXT_LIMITS.maxCategories,
  };
};
