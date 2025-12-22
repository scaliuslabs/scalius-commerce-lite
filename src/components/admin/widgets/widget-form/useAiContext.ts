
import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { useDebounce } from '@/hooks/use-debounce';
import type { Category } from '@/db/schema';
import type { MediaFile, ProductSearchResult } from './types';

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
  
  const [allCategoriesList, setAllCategoriesList] = useState<Category[]>([]);
  const [productSearchQuery, setProductSearchQuery] = useState("");
  const [productSearchResults, setProductSearchResults] = useState<ProductSearchResult[]>([]);
  const [latestProducts, setLatestProducts] = useState<ProductSearchResult[]>([]);
  const [productPage, setProductPage] = useState(1);
  const [hasMoreProducts, setHasMoreProducts] = useState(true);
  const [isFetchingProducts, setIsFetchingProducts] = useState(false);
  const [isProductPopoverOpen, setIsProductPopoverOpen] = useState(false);
  const debouncedProductSearch = useDebounce(productSearchQuery, 300);

  const fetchProductsForSelector = useCallback(async (pageToFetch: number) => {
    if (isFetchingProducts) return;
    setIsFetchingProducts(true);
    try {
      const response = await fetch(`/api/products?page=${pageToFetch}&limit=10&sort=updatedAt&order=desc`);
      if (response.ok) {
        const data = await response.json();
        const newProducts: ProductSearchResult[] = (data.products || []).map((p: any) => ({
          id: p.id,
          name: p.name,
          slug: p.slug,
          primaryImage: p.primaryImage,
        }));
        setLatestProducts((prev) => pageToFetch === 1 ? newProducts : [...prev, ...newProducts]);
        setProductPage(pageToFetch);
        setHasMoreProducts(data.pagination.totalPages > pageToFetch);
      }
    } catch (error: any) {
      console.error("Failed to fetch latest products:", error);
      toast.error("Could not load products.");
    } finally {
      setIsFetchingProducts(false);
    }
  }, [isFetchingProducts]);

  useEffect(() => {
    if (isProductPopoverOpen && latestProducts.length === 0) {
      fetchProductsForSelector(1);
    }
  }, [isProductPopoverOpen, latestProducts.length, fetchProductsForSelector]);

  useEffect(() => {
    const fetchCategories = async () => {
      try {
        const response = await fetch("/api/categories?limit=200");
        if (response.ok) {
          const data = await response.json();
          setAllCategoriesList(data.categories || []);
        }
      } catch (error) {
        console.error("Failed to fetch categories:", error);
      }
    };
    fetchCategories();
  }, []);

  useEffect(() => {
    const searchProducts = async () => {
      if (!debouncedProductSearch.trim()) {
        setProductSearchResults([]);
        return;
      }
      setIsFetchingProducts(true);
      try {
        const response = await fetch(`/api/products?search=${encodeURIComponent(debouncedProductSearch)}&limit=10`);
        if (response.ok) {
          const data = await response.json();
          const newProducts: ProductSearchResult[] = (data.products || []).map((p: any) => ({
            id: p.id,
            name: p.name,
            slug: p.slug,
            primaryImage: p.primaryImage,
          }));
          setProductSearchResults(newProducts);
        }
      } catch (error) {
        console.error("Failed to search products:", error);
      } finally {
        setIsFetchingProducts(false);
      }
    };
    if (debouncedProductSearch) {
      searchProducts();
    } else {
      setProductSearchResults([]);
    }
  }, [debouncedProductSearch]);

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

  const handleProductSelect = (product: ProductSearchResult) => {
    if (!selectedProducts.some((p) => p.id === product.id)) {
      setSelectedProducts((prev) => [...prev, product]);
    }
  };

  const removeProduct = (productId: string) => {
    setSelectedProducts((prev) => prev.filter((p) => p.id !== productId));
  };

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

  const productsToShow = debouncedProductSearch.trim() ? productSearchResults : latestProducts;

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
    hasMoreProducts,
    fetchProductsForSelector,
    productPage,
  };
};
