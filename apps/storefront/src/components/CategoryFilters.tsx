// src/components/CategoryFilters.tsx
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import type { BuyerPriceRange, ProductFacet } from "@/lib/api";
import type { ProductListFilterState } from "@/lib/product-list-query";
import { cn } from "@scalius/shared/utils";
import { getCurrencySymbol } from "@/lib/currency";
import {
  DEFAULT_MAX_PRICE,
  DEFAULT_MIN_PRICE,
  appendPriceFilterParams,
  parsePriceFilterValue,
} from "@/lib/filters/price-url";
import { normalizeSearchQuery } from "@/lib/search-query";
import { navigateToCatalogFilterSearch } from "@/lib/catalog-filter-dialog";

interface CategoryFiltersProps {
  facets: ProductFacet[];
  currentFilters: ProductListFilterState;
  categorySlug?: string;
  resetPath?: string;
  priceRange?: BuyerPriceRange;
}

export function formatCatalogPriceDisplay(
  price: number,
  symbol = getCurrencySymbol(),
): string {
  const formatted = new Intl.NumberFormat("en-US", {
    notation: Math.abs(price) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: Math.abs(price) < 100 ? 2 : 1,
  }).format(price);
  return `${symbol}${formatted}`;
}

/**
 * Extracts initial component state from URL parameters
 * Separates price filters from other filters for independent state management
 */
export const getInitialCategoryFilterState = (
  currentFilters: ProductListFilterState,
  priceRange?: BuyerPriceRange,
) => {
  const defaultMinPrice = priceRange?.min ?? DEFAULT_MIN_PRICE;
  const defaultMaxPrice = priceRange?.max ?? DEFAULT_MAX_PRICE;
  const minPrice = parsePriceFilterValue(
    Array.isArray(currentFilters.minPrice)
      ? currentFilters.minPrice.at(-1)
      : currentFilters.minPrice,
    defaultMinPrice,
  );
  const parsedMaxPrice = parsePriceFilterValue(
    Array.isArray(currentFilters.maxPrice)
      ? currentFilters.maxPrice.at(-1)
      : currentFilters.maxPrice,
    defaultMaxPrice,
  );
  const maxPrice = currentFilters.maxPrice
    ? parsedMaxPrice
    : Math.max(parsedMaxPrice, minPrice);
  const filters: Record<string, string[] | boolean> = {};

  // Extract non-navigation filters (exclude URL navigation and price params)
  Object.entries(currentFilters).forEach(([key, value]) => {
    if (!["q", "page", "sortBy", "minPrice", "maxPrice"].includes(key)) {
      const values = Array.isArray(value) ? value : [value];
      filters[key] =
        values.length === 1 && values[0] === "true" ? true : values;
    }
  });

  return {
    minPrice,
    maxPrice,
    minRange: Math.min(defaultMinPrice, minPrice),
    maxRange: Math.max(defaultMaxPrice, minPrice, maxPrice),
    defaultMaxPrice,
    filters,
  };
};

/**
 * CategoryFilters Component
 *
 * Handles all product filtering including:
 * - Price range (slider + manual input)
 * - Boolean switches (On Sale, Free Delivery)
 * - Dynamic attribute filters (Brand, Color, Size, etc.)
 *
 * Key Behaviors:
 * - Desktop: Auto-submits filters when changed (except during slider drag)
 * - Mobile: Manual submit via "Apply" button
 * - Price filters are preserved when other filters change
 * - All state is synchronized with URL parameters
 */
export default function CategoryFilters({
  facets,
  currentFilters,
  categorySlug,
  resetPath,
  priceRange,
}: CategoryFiltersProps) {
  // Parse initial state from URL parameters
  const initialState = useMemo(
    () => getInitialCategoryFilterState(currentFilters, priceRange),
    [currentFilters, priceRange],
  );

  /**
   * Price State Management
   * Consolidated into single object to prevent state synchronization issues
   * - userModified: Prevents price reset when other filters change
   * - priceChanged: Tracks whether the buyer explicitly changed the range
   */
  const [priceState, setPriceState] = useState(() => ({
    minPrice: initialState.minPrice,
    maxPrice: initialState.maxPrice,
    minPriceInput: initialState.minPrice.toString(), // Input shows actual values
    maxPriceInput: initialState.maxPrice.toString(),
    minRange: initialState.minRange,
    maxRange: initialState.maxRange,
    defaultMaxPrice: initialState.defaultMaxPrice,
    priceChanged: !!(currentFilters.minPrice || currentFilters.maxPrice),
    userModified: false, // Critical: prevents price reset from URL changes
  }));

  // Other filter state (switches, attributes)
  const [selectedFilters, setSelectedFilters] = useState(initialState.filters);
  const [expandedFacets, setExpandedFacets] = useState<Set<string>>(
    () => new Set(),
  );

  /**
   * Slider State Management
   * Prevents auto-submit during slider drag for better UX
   * Only submits on drag end (onValueCommit)
   */
  const [isSliderActive, setIsSliderActive] = useState(false);

  // Component lifecycle and optimization refs
  const isMounted = useRef(false);
  const priceUpdateTimeout = useRef<NodeJS.Timeout | null>(null);
  const lastSelectedFiltersRef = useRef(selectedFilters);

  // Utility: Check if user is on desktop (for auto-submit behavior)
  const isDesktop = () =>
    typeof window !== "undefined" && window.innerWidth >= 1024;

  /**
   * Price State Synchronization Effect
   *
   * CRITICAL BEHAVIOR: Only updates price from URL if user hasn't manually modified it
   * This prevents price reset when other filters change and cause re-renders
   *
   * Why this is needed:
   * 1. User sets price to 100-500
   * 2. User clicks "On Sale" switch
   * 3. Component re-renders with new currentFilters
   * 4. Without userModified check, price would reset to URL values
   * 5. With userModified=true, price is preserved
   */
  useEffect(() => {
    if (!priceState.userModified) {
      const newMinPrice = parsePriceFilterValue(
        Array.isArray(currentFilters.minPrice)
          ? currentFilters.minPrice.at(-1)
          : currentFilters.minPrice,
        priceRange?.min ?? DEFAULT_MIN_PRICE,
      );
      const parsedMaxPrice = parsePriceFilterValue(
        Array.isArray(currentFilters.maxPrice)
          ? currentFilters.maxPrice.at(-1)
          : currentFilters.maxPrice,
        priceRange?.max ?? DEFAULT_MAX_PRICE,
      );
      const newMaxPrice = currentFilters.maxPrice
        ? parsedMaxPrice
        : Math.max(parsedMaxPrice, newMinPrice);

      setPriceState((prev) => ({
        ...prev,
        minPrice: newMinPrice,
        maxPrice: newMaxPrice,
        minPriceInput: newMinPrice.toString(),
        maxPriceInput: newMaxPrice.toString(),
        minRange: Math.min(priceRange?.min ?? DEFAULT_MIN_PRICE, newMinPrice),
        maxRange: Math.max(
          priceRange?.max ?? DEFAULT_MAX_PRICE,
          newMinPrice,
          newMaxPrice,
        ),
        defaultMaxPrice: priceRange?.max ?? DEFAULT_MAX_PRICE,
        priceChanged: !!(currentFilters.minPrice || currentFilters.maxPrice),
      }));
    }
  }, [
    currentFilters.minPrice,
    currentFilters.maxPrice,
    priceRange,
    priceState.userModified,
  ]);

  /**
   * Form Submission Handler
   *
   * Builds URL parameters and navigates to new page
   *
   * @param currentQuery - Search query (optional)
   * @param includePriceFilter - Whether to include price in URL (critical for preserving price)
   *
   * Parameter Logic:
   * - Always include: query, page=1, sortBy
   * - Conditionally include: price filters (only if includePriceFilter=true AND priceChanged=true)
   * - Always include: other filters (switches, attributes)
   */
  const prepareAndSubmitForm = useCallback(
    (currentQuery?: string, includePriceFilter = false) => {
      const form = document.getElementById("filterForm") as HTMLFormElement;
      if (!form) return;

      const formData = new FormData(form);
      const query = normalizeSearchQuery(
        currentQuery ?? formData.get("q")?.toString(),
      );

      const finalParams = new URLSearchParams();

      // Core navigation parameters
      if (query) finalParams.set("q", query);
      const sortBy = formData.get("sortBy")?.toString();
      if (sortBy && sortBy !== "newest") finalParams.set("sortBy", sortBy);

      // Price parameters (only if explicitly requested AND price was changed)
      appendPriceFilterParams(finalParams, {
        includePriceFilter,
        priceChanged: priceState.priceChanged,
        minPriceInput: priceState.minPriceInput,
        maxPriceInput: priceState.maxPriceInput,
        defaultMaxPrice: priceState.defaultMaxPrice,
      });

      // Other filter parameters (switches, attributes)
      Object.entries(selectedFilters).forEach(([key, value]) => {
        if (value === false) return;
        if (Array.isArray(value)) {
          for (const selectedValue of value)
            finalParams.append(key, selectedValue);
        } else if (value === true) finalParams.set(key, "true");
      });

      // Navigate to new URL
      navigateToCatalogFilterSearch(finalParams);
    },
    [
      priceState.priceChanged,
      priceState.minPriceInput,
      priceState.maxPriceInput,
      priceState.defaultMaxPrice,
      selectedFilters,
    ],
  );

  /**
   * Auto-Submit Effect for Non-Price Filters
   *
   * Handles automatic form submission on desktop when filters change
   * CRITICAL: Always includes price filter to prevent price reset
   *
   * Behavior:
   * - Skip on first mount (prevents double submission)
   * - Only auto-submit on desktop
   * - Don't auto-submit during slider drag
   * - ALWAYS pass includePriceFilter=true to preserve price
   */
  useEffect(() => {
    // Skip first mount to prevent unnecessary submission
    if (!isMounted.current) {
      isMounted.current = true;
      lastSelectedFiltersRef.current = selectedFilters;
      return;
    }

    const filtersChanged =
      JSON.stringify(selectedFilters) !==
      JSON.stringify(lastSelectedFiltersRef.current);

    if (filtersChanged && isDesktop() && !isSliderActive) {
      lastSelectedFiltersRef.current = selectedFilters;
      // CRITICAL: Always include price filter to prevent reset
      prepareAndSubmitForm(undefined, true);
    } else {
      lastSelectedFiltersRef.current = selectedFilters;
    }
  }, [selectedFilters, prepareAndSubmitForm, isSliderActive]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (priceUpdateTimeout.current) {
        clearTimeout(priceUpdateTimeout.current);
      }
    };
  }, []);

  /**
   * Form Event Handlers Setup
   *
   * Handles:
   * - Form submission (Enter key or form submit)
   * - Search input Enter key
   *
   * Both always include price filter to maintain price state
   */
  useEffect(() => {
    const form = document.getElementById("filterForm");
    const searchInput = form?.querySelector(
      'input[name="q"]',
    ) as HTMLInputElement;

    if (!form) return;

    const handleSubmit = (event: Event) => {
      event.preventDefault();
      const query = searchInput ? searchInput.value : "";
      prepareAndSubmitForm(query, true);
    };

    const handleSearchKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        prepareAndSubmitForm((event.target as HTMLInputElement).value, true);
      }
    };

    form.addEventListener("submit", handleSubmit);
    if (searchInput) {
      searchInput.addEventListener("keydown", handleSearchKeyDown);
    }

    return () => {
      form.removeEventListener("submit", handleSubmit);
      if (searchInput) {
        searchInput.removeEventListener("keydown", handleSearchKeyDown);
      }
    };
  }, [prepareAndSubmitForm]);

  /**
   * Price Slider Handlers
   *
   * handleSliderChange: Updates state during drag (no submission)
   * handleSliderStart: Prevents auto-submit during drag
   * handleSliderEnd: Triggers submission after drag completes
   */
  const handleSliderChange = (values: number[]) => {
    const [min, max] = values;

    setPriceState((prev) => ({
      ...prev,
      minPrice: min,
      maxPrice: max,
      minPriceInput: min.toString(),
      maxPriceInput: max.toString(),
      priceChanged: true,
      userModified: true, // Mark as user modified to prevent resets
    }));
  };

  const handleSliderStart = () => {
    setIsSliderActive(true);
    // Clear any pending price updates
    if (priceUpdateTimeout.current) {
      clearTimeout(priceUpdateTimeout.current);
      priceUpdateTimeout.current = null;
    }
  };

  const handleSliderEnd = () => {
    setIsSliderActive(false);
    // Clear any pending timeouts
    if (priceUpdateTimeout.current) {
      clearTimeout(priceUpdateTimeout.current);
      priceUpdateTimeout.current = null;
    }

    // Auto-submit on desktop after brief delay (debouncing)
    if (isDesktop()) {
      priceUpdateTimeout.current = setTimeout(() => {
        prepareAndSubmitForm(undefined, true);
      }, 150);
    }
  };

  /**
   * Price Input Handlers
   *
   * Handles manual price input changes
   * Updates both slider position and input values
   * Extends max range if user enters value beyond current range
   */
  const handlePriceInputChange = (type: "min" | "max", value: string) => {
    const parsedValue = Number(value);
    const numValue =
      Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : 0;

    setPriceState((prev) => {
      const newState = {
        ...prev,
        priceChanged: true,
        userModified: true, // Mark as user modified
      };

      if (type === "min") {
        newState.minPriceInput = value;
        newState.minPrice = numValue;
        if (numValue < prev.minRange) newState.minRange = numValue;
      } else {
        newState.maxPriceInput = value;
        newState.maxPrice = numValue;
        // Extend slider range if needed
        if (numValue > prev.maxRange) {
          newState.maxRange = numValue;
        }
      }

      return newState;
    });
  };

  // Handle Enter key in price inputs
  const handlePriceInputKeyPress = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      prepareAndSubmitForm(undefined, true);
    }
  };

  /**
   * Switch Filter Handlers
   *
   * Handles boolean filters like "On Sale" and "Free Delivery"
   * Adds/removes from selectedFilters object
   */
  const handleSwitchChange = (name: string, checked: boolean) => {
    setSelectedFilters((prev) => {
      const newFilters = { ...prev };
      if (checked) {
        newFilters[name] = true;
      } else {
        delete newFilters[name];
      }
      return newFilters;
    });
  };

  /**
   * Attribute Filter Handlers
   *
   * Handles dynamic attribute filters (Brand, Color, Size, etc.)
   * - Clicking same value again removes filter
   * - Clicking "All" removes filter
   * - Only one value per attribute allowed
   */
  const handleAttributeClick = (attrSlug: string, value: string | null) => {
    setSelectedFilters((prev) => {
      const newFilters = { ...prev };
      if (value === null) {
        delete newFilters[attrSlug];
      } else {
        const selected = Array.isArray(newFilters[attrSlug])
          ? newFilters[attrSlug]
          : [];
        const next = selected.includes(value)
          ? selected.filter((candidate) => candidate !== value)
          : [...selected, value];
        if (next.length > 0) newFilters[attrSlug] = next;
        else delete newFilters[attrSlug];
      }
      return newFilters;
    });
  };

  // Mobile "Apply" button handler
  const handleApplyFilters = () => {
    prepareAndSubmitForm(undefined, true);
  };

  // Format price display for slider labels
  const sliderStep = useMemo(() => {
    const span = Math.max(0, priceState.maxRange - priceState.minRange);
    if (span <= 100) return 0.01;
    if (span <= 1_000) return 1;
    if (span <= 100_000) return 100;
    return 1_000;
  }, [priceState.maxRange, priceState.minRange]);

  const selectedAttributeChips = useMemo(
    () =>
      facets.flatMap((facet) => {
        const rawSelected = selectedFilters[facet.slug];
        const selected: string[] = Array.isArray(rawSelected)
          ? rawSelected
          : [];
        return selected.map((value) => ({
          slug: facet.slug,
          label: facet.name,
          value,
        }));
      }),
    [facets, selectedFilters],
  );
  const resetHref =
    resetPath ?? (categorySlug ? `/categories/${categorySlug}` : "/search");
  const hasResettableFilters = useMemo(
    () =>
      priceState.priceChanged ||
      Boolean(
        normalizeSearchQuery(
          Array.isArray(currentFilters.q)
            ? currentFilters.q.at(-1)
            : currentFilters.q,
        ),
      ) ||
      Object.values(selectedFilters).some(
        (value) => value === true || (Array.isArray(value) && value.length > 0),
      ),
    [currentFilters.q, priceState.priceChanged, selectedFilters],
  );
  const selectedAttributeValues = (slug: string): string[] => {
    const selected = selectedFilters[slug];
    return Array.isArray(selected) ? selected : [];
  };
  const defaultOpenSections = useMemo(
    () => [
      "general",
      "price",
      ...facets.slice(0, 3).map((facet) => facet.slug),
    ],
    [facets],
  );
  const visibleFacetValues = (facet: ProductFacet) => {
    if (expandedFacets.has(facet.slug) || facet.values.length <= 10) {
      return facet.values;
    }
    const selected = new Set(selectedAttributeValues(facet.slug));
    return facet.values.filter(
      ({ value }, index) => index < 10 || selected.has(value),
    );
  };
  const toggleFacetExpansion = (slug: string) => {
    setExpandedFacets((current) => {
      const next = new Set(current);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  return (
    <>
      {/* Main Filter Content */}
      <div className="pb-28 lg:pb-4">
        <Accordion
          type="multiple"
          className="w-full space-y-3"
          defaultValue={defaultOpenSections}
        >
          {selectedAttributeChips.length > 0 && (
            <div
              className="flex flex-wrap gap-1.5"
              aria-label="Selected filters"
            >
              {selectedAttributeChips.map((chip) => (
                <button
                  key={`${chip.slug}:${chip.value}`}
                  type="button"
                  onClick={() => handleAttributeClick(chip.slug, chip.value)}
                  className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/10"
                  aria-label={`Remove ${chip.label}: ${chip.value}`}
                >
                  <span>
                    {chip.label}: {chip.value}
                  </span>
                  <span aria-hidden="true">×</span>
                </button>
              ))}
            </div>
          )}
          {/* General Filters Section */}
          <AccordionItem
            value="general"
            className="rounded-lg border border-border bg-background"
          >
            <AccordionTrigger className="px-4 py-3 hover:no-underline">
              <span className="font-semibold text-foreground">
                Shopping options
              </span>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4">
              <div className="space-y-4">
                {/* On Sale Switch */}
                <div className="flex min-h-11 items-center justify-between rounded-lg bg-muted/50 px-3 py-2">
                  <label
                    htmlFor="hasDiscount"
                    className="cursor-pointer text-sm font-medium text-foreground"
                  >
                    On sale
                  </label>
                  <Switch
                    id="hasDiscount"
                    name="hasDiscount"
                    checked={!!selectedFilters.hasDiscount}
                    onCheckedChange={(c) =>
                      handleSwitchChange("hasDiscount", c)
                    }
                  />
                </div>

                {/* Free Delivery Switch */}
                <div className="flex min-h-11 items-center justify-between rounded-lg bg-muted/50 px-3 py-2">
                  <label
                    htmlFor="freeDelivery"
                    className="cursor-pointer text-sm font-medium text-foreground"
                  >
                    Free delivery
                  </label>
                  <Switch
                    id="freeDelivery"
                    name="freeDelivery"
                    checked={!!selectedFilters.freeDelivery}
                    onCheckedChange={(c) =>
                      handleSwitchChange("freeDelivery", c)
                    }
                  />
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* Price Range Section */}
          <AccordionItem
            value="price"
            className="rounded-lg border border-border bg-background"
          >
            <AccordionTrigger className="px-4 py-3 hover:no-underline">
              <span className="font-semibold text-foreground">Price</span>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4">
              <div className="space-y-6">
                {/* Price Slider */}
                <div className="px-3 pt-2 pb-4">
                  <Slider
                    value={[priceState.minPrice, priceState.maxPrice]}
                    min={priceState.minRange}
                    max={priceState.maxRange}
                    step={sliderStep}
                    disabled={priceState.maxRange <= priceState.minRange}
                    onValueChange={handleSliderChange}
                    onValueCommit={handleSliderEnd}
                    onPointerDown={handleSliderStart}
                    className="w-full"
                  />
                  {/* Slider Value Display */}
                  <div className="mt-4 flex justify-between px-1 text-xs text-muted-foreground">
                    <span>{formatCatalogPriceDisplay(priceState.minPrice)}</span>
                    <span>{formatCatalogPriceDisplay(priceState.maxPrice)}</span>
                  </div>
                </div>

                {/* Manual Price Inputs */}
                <div className="grid grid-cols-2 gap-3">
                  {/* Min Price Input */}
                  <div>
                    <label
                      htmlFor="catalog-min-price"
                      className="mb-2 block text-xs font-medium text-muted-foreground"
                    >
                      Minimum
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                        {getCurrencySymbol()}
                      </span>
                      <Input
                        id="catalog-min-price"
                        type="number"
                        value={priceState.minPriceInput}
                        onChange={(e) =>
                          handlePriceInputChange("min", e.target.value)
                        }
                        onKeyDown={handlePriceInputKeyPress}
                        className="h-11 pl-7 text-sm lg:h-9"
                        placeholder="0"
                        min="0"
                        step="any"
                      />
                    </div>
                  </div>

                  {/* Max Price Input */}
                  <div>
                    <label
                      htmlFor="catalog-max-price"
                      className="mb-2 block text-xs font-medium text-muted-foreground"
                    >
                      Maximum
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                        {getCurrencySymbol()}
                      </span>
                      <Input
                        id="catalog-max-price"
                        type="number"
                        value={priceState.maxPriceInput}
                        onChange={(e) =>
                          handlePriceInputChange("max", e.target.value)
                        }
                        onKeyDown={handlePriceInputKeyPress}
                        className="h-11 pl-7 text-sm lg:h-9"
                        placeholder={priceState.defaultMaxPrice.toString()}
                        min="0"
                        step="any"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* Dynamic Attribute Filters */}
          {facets.map((attr) => (
            <AccordionItem
              key={attr.id}
              value={attr.slug}
              className="rounded-lg border border-border bg-background"
            >
              <AccordionTrigger className="px-4 py-3 hover:no-underline">
                <span className="font-semibold text-foreground">{attr.name}</span>
              </AccordionTrigger>
              <AccordionContent className="px-4 pb-4">
                <div className="space-y-1">
                  {visibleFacetValues(attr).map(({ value, count }) => {
                    const selected = selectedAttributeValues(
                      attr.slug,
                    ).includes(value);
                    const disabled = count === 0 && !selected;
                    return (
                      <label
                        key={value}
                        className={cn(
                          "flex min-h-11 items-center gap-3 rounded-md px-2 text-sm transition-colors",
                          disabled
                            ? "cursor-not-allowed opacity-40"
                            : "cursor-pointer hover:bg-muted",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={disabled}
                          onChange={() =>
                            handleAttributeClick(attr.slug, value)
                          }
                          className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                        />
                        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                          {value}
                        </span>
                        <span className="tabular-nums text-xs text-muted-foreground">
                          {count}
                        </span>
                      </label>
                    );
                  })}
                  {attr.values.length > 10 && (
                    <button
                      type="button"
                      onClick={() => toggleFacetExpansion(attr.slug)}
                      className="min-h-11 px-2 text-sm font-medium text-primary hover:underline lg:min-h-10"
                      aria-expanded={expandedFacets.has(attr.slug)}
                    >
                      {expandedFacets.has(attr.slug)
                        ? "Show less"
                        : `Show ${attr.values.length - 10} more`}
                    </button>
                  )}
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>

        {/* Desktop Reset Button */}
        {hasResettableFilters ? (
          <div className="hidden pt-6 lg:block">
            <Button variant="outline" asChild className="w-full">
              <a href={resetHref}>Clear all</a>
            </Button>
          </div>
        ) : null}
      </div>

      {/* Mobile Action Bar */}
      <div className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background p-4 pb-[max(1rem,env(safe-area-inset-bottom))] lg:hidden">
        <div
          className={cn(
            "grid gap-3",
            hasResettableFilters ? "grid-cols-2" : "grid-cols-1",
          )}
        >
          {/* Mobile Reset Button */}
          {hasResettableFilters ? (
            <Button variant="outline" asChild className="h-12">
              <a href={resetHref}>Clear all</a>
            </Button>
          ) : null}

          {/* Mobile Apply Button */}
          <Button type="button" onClick={handleApplyFilters} className="h-12">
            Show products
          </Button>
        </div>
      </div>
    </>
  );
}
