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
import type { BuyerPriceRange, FilterableAttribute } from "@/lib/api";
import { cn } from "@scalius/shared/utils";
import { getCurrencySymbol } from "@/lib/currency";
import {
  DEFAULT_MAX_PRICE,
  DEFAULT_MIN_PRICE,
  appendPriceFilterParams,
  parsePriceFilterValue,
} from "@/lib/filters/price-url";
import { normalizeSearchQuery } from "@/lib/search-query";

interface CategoryFiltersProps {
  attributes: FilterableAttribute[];
  currentFilters: Record<string, string>;
  categorySlug?: string;
  priceRange?: BuyerPriceRange;
}

/**
 * Extracts initial component state from URL parameters
 * Separates price filters from other filters for independent state management
 */
const getInitialState = (
  currentFilters: Record<string, string>,
  priceRange?: BuyerPriceRange,
) => {
  const defaultMinPrice = priceRange?.min ?? DEFAULT_MIN_PRICE;
  const defaultMaxPrice = priceRange?.max ?? DEFAULT_MAX_PRICE;
  const minPrice = parsePriceFilterValue(
    currentFilters.minPrice,
    defaultMinPrice,
  );
  const maxPrice = parsePriceFilterValue(
    currentFilters.maxPrice,
    defaultMaxPrice,
  );
  const filters: Record<string, string | boolean> = {};

  // Extract non-navigation filters (exclude URL navigation and price params)
  Object.entries(currentFilters).forEach(([key, value]) => {
    if (!["q", "page", "sortBy", "minPrice", "maxPrice"].includes(key)) {
      filters[key] = value === "true" ? true : value;
    }
  });

  return {
    minPrice,
    maxPrice,
    minRange: Math.min(defaultMinPrice, minPrice),
    maxRange: Math.max(defaultMaxPrice, maxPrice),
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
  attributes,
  currentFilters,
  categorySlug,
  priceRange,
}: CategoryFiltersProps) {
  // Parse initial state from URL parameters
  const initialState = useMemo(
    () => getInitialState(currentFilters, priceRange),
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
        currentFilters.minPrice,
        priceRange?.min ?? DEFAULT_MIN_PRICE,
      );
      const newMaxPrice = parsePriceFilterValue(
        currentFilters.maxPrice,
        priceRange?.max ?? DEFAULT_MAX_PRICE,
      );

      setPriceState((prev) => ({
        ...prev,
        minPrice: newMinPrice,
        maxPrice: newMaxPrice,
        minPriceInput: newMinPrice.toString(),
        maxPriceInput: newMaxPrice.toString(),
        minRange: Math.min(priceRange?.min ?? DEFAULT_MIN_PRICE, newMinPrice),
        maxRange: Math.max(priceRange?.max ?? DEFAULT_MAX_PRICE, newMaxPrice),
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
      const query = normalizeSearchQuery(currentQuery ?? formData.get("q")?.toString());

      const finalParams = new URLSearchParams();

      // Core navigation parameters
      if (query) finalParams.set("q", query);
      finalParams.set("page", "1"); // Always reset to first page
      finalParams.set("sortBy", formData.get("sortBy")?.toString() || "newest");

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
        if (value !== "" && value !== false) {
          finalParams.set(key, String(value));
        }
      });

      // Navigate to new URL
      window.location.search = finalParams.toString();
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
    const numValue = Number.isFinite(parsedValue) && parsedValue >= 0
      ? parsedValue
      : 0;

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
      if (value === null || newFilters[attrSlug] === value) {
        // Remove filter if clicking "All" or same value
        delete newFilters[attrSlug];
      } else {
        // Set new filter value
        newFilters[attrSlug] = value;
      }
      return newFilters;
    });
  };

  // Mobile "Apply" button handler
  const handleApplyFilters = () => {
    prepareAndSubmitForm(undefined, true);
  };

  // Format price display for slider labels
  const formatPriceDisplay = (price: number): string => {
    const sym = getCurrencySymbol();
    const formatted = new Intl.NumberFormat(undefined, {
      notation: Math.abs(price) >= 10_000 ? "compact" : "standard",
      maximumFractionDigits: Math.abs(price) < 100 ? 2 : 1,
    }).format(price);
    return `${sym}${formatted}`;
  };

  const sliderStep = useMemo(() => {
    const span = Math.max(0, priceState.maxRange - priceState.minRange);
    if (span <= 100) return 0.01;
    if (span <= 1_000) return 1;
    if (span <= 100_000) return 100;
    return 1_000;
  }, [priceState.maxRange, priceState.minRange]);

  return (
    <>
      {/* Main Filter Content */}
      <div className="pb-24 lg:pb-4">
        <Accordion
          type="multiple"
          className="w-full space-y-3"
          defaultValue={["general", "price", ...attributes.map((a) => a.slug)]}
        >
          {/* General Filters Section */}
          <AccordionItem
            value="general"
            className="border border-gray-200 rounded-lg bg-white"
          >
            <AccordionTrigger className="px-4 py-3 hover:no-underline">
              <span className="font-semibold text-gray-900">General</span>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4">
              <div className="space-y-4">
                {/* On Sale Switch */}
                <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <label
                    htmlFor="hasDiscount"
                    className="text-sm font-medium text-gray-700 cursor-pointer"
                  >
                    On Sale
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
                <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <label
                    htmlFor="freeDelivery"
                    className="text-sm font-medium text-gray-700 cursor-pointer"
                  >
                    Free Delivery
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
            className="border border-gray-200 rounded-lg bg-white"
          >
            <AccordionTrigger className="px-4 py-3 hover:no-underline">
              <span className="font-semibold text-gray-900">Price Range</span>
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
                  <div className="flex justify-between text-xs text-gray-500 mt-4 px-1">
                    <span>{formatPriceDisplay(priceState.minPrice)}</span>
                    <span>{formatPriceDisplay(priceState.maxPrice)}</span>
                  </div>
                </div>

                {/* Manual Price Inputs */}
                <div className="grid grid-cols-2 gap-3">
                  {/* Min Price Input */}
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-2">
                      Minimum
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500">
                        {getCurrencySymbol()}
                      </span>
                      <Input
                        type="number"
                        value={priceState.minPriceInput}
                        onChange={(e) =>
                          handlePriceInputChange("min", e.target.value)
                        }
                        onKeyDown={handlePriceInputKeyPress}
                        className="pl-7 h-9 text-sm"
                        placeholder="0"
                        min="0"
                        step="any"
                      />
                    </div>
                  </div>

                  {/* Max Price Input */}
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-2">
                      Maximum
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500">
                        {getCurrencySymbol()}
                      </span>
                      <Input
                        type="number"
                        value={priceState.maxPriceInput}
                        onChange={(e) =>
                          handlePriceInputChange("max", e.target.value)
                        }
                        onKeyDown={handlePriceInputKeyPress}
                        className="pl-7 h-9 text-sm"
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
          {attributes.map((attr) => (
            <AccordionItem
              key={attr.id}
              value={attr.slug}
              className="border border-gray-200 rounded-lg bg-white"
            >
              <AccordionTrigger className="px-4 py-3 hover:no-underline">
                <span className="font-semibold text-gray-900">{attr.name}</span>
              </AccordionTrigger>
              <AccordionContent className="px-4 pb-4">
                <div className="flex flex-wrap gap-2">
                  {/* "All" Button - Clears Filter */}
                  <button
                    type="button"
                    onClick={() => handleAttributeClick(attr.slug, null)}
                    className={cn(
                      "font-medium rounded-lg border px-3 py-2 text-sm transition-colors",
                      !selectedFilters[attr.slug]
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-white hover:bg-gray-50 border-gray-200",
                    )}
                  >
                    All
                  </button>

                  {/* Attribute Value Buttons */}
                  {attr.values.map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => handleAttributeClick(attr.slug, value)}
                      className={cn(
                        "font-medium rounded-lg border px-3 py-2 text-sm transition-colors",
                        selectedFilters[attr.slug] === value
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-white hover:bg-gray-50 border-gray-200",
                      )}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>

        {/* Desktop Reset Button */}
        <div className="pt-6 hidden lg:block">
          <Button variant="outline" asChild className="w-full">
            <a href={categorySlug ? `/categories/${categorySlug}` : "/search"}>
              Reset Filters
            </a>
          </Button>
        </div>
      </div>

      {/* Mobile Action Bar */}
      <div className="lg:hidden fixed bottom-0 left-0 right-0 bg-white border-t p-4 z-50">
        <div className="grid grid-cols-2 gap-3">
          {/* Mobile Reset Button */}
          <Button variant="outline" asChild className="h-12">
            <a href={categorySlug ? `/categories/${categorySlug}` : "/search"}>
              Reset
            </a>
          </Button>

          {/* Mobile Apply Button */}
          <Button type="button" onClick={handleApplyFilters} className="h-12">
            Apply
          </Button>
        </div>
      </div>
    </>
  );
}
