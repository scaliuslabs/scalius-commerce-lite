
import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { useDebounce } from '@/hooks/use-debounce';
import type { Category } from '@/types/api-responses';
import type { MediaFile, ProductSearchResult } from './types';
import { getProducts, getCategories } from "@/lib/api.functions";

interface RawProduct {
  id: string;
  name: string;
  slug: string;
  primaryImage: string | null;
}

const PAGE_SIZE = 10;

export const useAiContext = (
  initialContext?: {
    images?: MediaFile[];
    products?: ProductSearchResult[];
    categories?: Category[];
    allCategories?: boolean;
  }
) => {
  const [selectedImages, setSelectedImages] = useState<MediaFile[]>(initialContext?.images || []);
  const [selectedProducts, setSelectedProducts] = useState<ProductSearchResult[]>(initialContext?.products || []);
  const [selectedCategories, setSelectedCategories] = useState<Category[]>(initialContext?.categories || []);
  const [allCategoriesSelected, setAllCategoriesSelected] = useState(initialContext?.allCategories || false);

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
  const debouncedCategorySearch = useDebounce(categorySearchQuery, 300);

  // ─── Products: browse (no search) ───────────────────────────────────
  const fetchProductsForSelector = useCallback(async (pageToFetch: number) => {
    if (isFetchingProducts) return;
    setIsFetchingProducts(true);
    try {
      const data = await getProducts({
        data: { page: pageToFetch, limit: PAGE_SIZE, sort: "updatedAt", order: "desc" },
      }) as Record<string, unknown>;
      const newProducts: ProductSearchResult[] = ((data.products || []) as RawProduct[]).map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        primaryImage: p.primaryImage,
      }));
      setLatestProducts((prev) => pageToFetch === 1 ? newProducts : [...prev, ...newProducts]);
      setProductPage(pageToFetch);
      const pagination = data.pagination as Record<string, unknown>;
      setHasMoreProducts((pagination.totalPages as number) > pageToFetch);
    } catch (error: unknown) {
      if (import.meta.env.DEV) console.error("Failed to fetch latest products:", error);
      toast.error("Could not load products.");
    } finally {
      setIsFetchingProducts(false);
    }
  }, [isFetchingProducts]);

  // ─── Products: search with pagination ───────────────────────────────
  const fetchSearchProducts = useCallback(async (query: string, pageToFetch: number) => {
    if (isFetchingProducts) return;
    setIsFetchingProducts(true);
    try {
      const data = await getProducts({
        data: { search: query, page: pageToFetch, limit: PAGE_SIZE },
      }) as Record<string, unknown>;
      const newProducts: ProductSearchResult[] = ((data.products || []) as RawProduct[]).map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        primaryImage: p.primaryImage,
      }));
      setProductSearchResults((prev) => pageToFetch === 1 ? newProducts : [...prev, ...newProducts]);
      setProductSearchPage(pageToFetch);
      const pagination = data.pagination as Record<string, unknown>;
      setHasMoreSearchProducts((pagination.totalPages as number) > pageToFetch);
    } catch (error) {
      if (import.meta.env.DEV) console.error("Failed to search products:", error);
    } finally {
      setIsFetchingProducts(false);
    }
  }, [isFetchingProducts]);

  const loadMoreProducts = useCallback(() => {
    if (debouncedProductSearch.trim()) {
      fetchSearchProducts(debouncedProductSearch, productSearchPage + 1);
    } else {
      fetchProductsForSelector(productPage + 1);
    }
  }, [debouncedProductSearch, productSearchPage, productPage, fetchSearchProducts, fetchProductsForSelector]);

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
      setProductSearchResults([]);
      setProductSearchPage(1);
      setHasMoreSearchProducts(false);
    }
  }, [debouncedProductSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Categories: paginated fetch ────────────────────────────────────
  const fetchCategoriesPage = useCallback(async (pageToFetch: number, search?: string) => {
    if (isFetchingCategories) return;
    setIsFetchingCategories(true);
    try {
      const params: { page: number; limit: number; search?: string } = {
        page: pageToFetch,
        limit: PAGE_SIZE,
      };
      if (search) params.search = search;
      const data = await getCategories({ data: params }) as Record<string, unknown>;
      const newCategories = (data.categories || []) as Category[];
      setAllCategoriesList((prev) => pageToFetch === 1 ? newCategories : [...prev, ...newCategories]);
      setCategoryPage(pageToFetch);
      const pagination = data.pagination as Record<string, unknown> | undefined;
      if (pagination) {
        setHasMoreCategories((pagination.totalPages as number) > pageToFetch);
      } else {
        // If no pagination info, assume no more if fewer than PAGE_SIZE returned
        setHasMoreCategories(newCategories.length >= PAGE_SIZE);
      }
    } catch (error) {
      if (import.meta.env.DEV) console.error("Failed to fetch categories:", error);
    } finally {
      setIsFetchingCategories(false);
    }
  }, [isFetchingCategories]);

  const loadMoreCategories = useCallback(() => {
    const search = debouncedCategorySearch.trim() || undefined;
    fetchCategoriesPage(categoryPage + 1, search);
  }, [categoryPage, debouncedCategorySearch, fetchCategoriesPage]);

  // Initial categories load
  useEffect(() => {
    fetchCategoriesPage(1);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Category search effect
  useEffect(() => {
    setAllCategoriesList([]);
    setCategoryPage(1);
    setHasMoreCategories(true);
    const search = debouncedCategorySearch.trim() || undefined;
    fetchCategoriesPage(1, search);
  }, [debouncedCategorySearch]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Image handlers ─────────────────────────────────────────────────
  const handleImageSelect = (file: MediaFile) => {
    if (!selectedImages.some((img) => img.url === file.url)) {
      setSelectedImages((prev) => [...prev, file]);
    }
  };

  const handleMultiImageSelect = (files: MediaFile[]) => {
    const newImages = files.filter((file) => !selectedImages.some((img) => img.url === file.url));
    setSelectedImages((prev) => [...prev, ...newImages]);
  };

  const removeImage = (imageUrl: string) => {
    setSelectedImages((prev) => prev.filter((img) => img.url !== imageUrl));
  };

  // ─── Product handlers ──────────────────────────────────────────────
  const handleProductSelect = (product: ProductSearchResult) => {
    if (!selectedProducts.some((p) => p.id === product.id)) {
      setSelectedProducts((prev) => [...prev, product]);
    }
  };

  const removeProduct = (productId: string) => {
    setSelectedProducts((prev) => prev.filter((p) => p.id !== productId));
  };

  // ─── Category handlers ─────────────────────────────────────────────
  const handleCategorySelect = (category: Category) => {
    if (!selectedCategories.some((c) => c.id === category.id)) {
      setSelectedCategories((prev) => [...prev, category]);
    } else {
      removeCategory(category.id);
    }
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
    allCategoriesList,
    isProductPopoverOpen,
    setIsProductPopoverOpen,
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
    hasMoreCategories,
    loadMoreCategories,
    isFetchingCategories,
  };
};
