// src/components/search/CommandPalette.tsx
import React, { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  Search,
  Package,
  Layers,
  Loader2,
  ChevronRight,
  AlertCircle,
  X,
  ArrowRight,
  FileText,
} from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { getCurrencySymbol } from "@/lib/currency";
import { getProductImageUrl, hasProductImage } from "@/lib/product-media";
import { createApiUrl } from "@/lib/api/client";
import { normalizeSearchQuery } from "@/lib/search-query";

interface SearchResultItem {
  id: string;
  name?: string;
  title?: string;
  slug: string;
  price?: number;
  imageUrl?: string | null;
  imageAlt?: string | null;
  discountedPrice?: number;
  priceVaries?: boolean;
  availableForSale?: boolean;
}

interface SearchResponse {
  products: SearchResultItem[];
  categories: SearchResultItem[];
  pages: SearchResultItem[];
}

interface ApiResponse {
  success: boolean;
  data: SearchResponse;
}

// Match Shopify's predictive-search pattern: keep successful results for the
// lifetime of the page so revisiting or refining the same query is immediate.
// Full navigations naturally clear this small, bounded cache.
const SEARCH_RESULT_CACHE_LIMIT = 40;
const PREDICTIVE_SEARCH_DEBOUNCE_MS = 150;
const PREDICTIVE_SEARCH_RESULT_LIMIT = "7";
const searchResultCache = new Map<string, SearchResponse>();

function getSearchCacheKey(query: string): string {
  return query.toLocaleLowerCase();
}

function cacheSearchResults(query: string, results: SearchResponse): void {
  const key = getSearchCacheKey(query);
  if (!searchResultCache.has(key) && searchResultCache.size >= SEARCH_RESULT_CACHE_LIMIT) {
    const oldestKey = searchResultCache.keys().next().value;
    if (oldestKey) searchResultCache.delete(oldestKey);
  }
  searchResultCache.set(key, results);
}

export default function CommandPalette() {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchRetry, setSearchRetry] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchRunRef = useRef(0);
  const normalizedQuery = React.useMemo(() => normalizeSearchQuery(query), [query]);

  useEffect(() => {
    setMounted(true);
  }, []);

  const flatResults = React.useMemo(() => {
    if (!results) return [];
    const list: {
      type: "product" | "category" | "page";
      item: SearchResultItem;
    }[] = [];
    results.products.forEach((p) => list.push({ type: "product", item: p }));
    results.categories.forEach((c) => list.push({ type: "category", item: c }));
    results.pages.forEach((p) => list.push({ type: "page", item: p }));
    return list;
  }, [results]);

  useEffect(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
      if (e.key === "Escape") {
        setIsOpen(false);
      }
    };

    const handleCustomEvent = () => setIsOpen(true);

    document.addEventListener("keydown", handleKeydown);
    document.addEventListener("open-search-palette", handleCustomEvent);
    return () => {
      document.removeEventListener("keydown", handleKeydown);
      document.removeEventListener("open-search-palette", handleCustomEvent);
    };
  }, []);

  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      document.body.style.overflow = "hidden";
      setSelectedIndex(0);
      requestAnimationFrame(() => {
        setTimeout(() => inputRef.current?.focus(), 50);
      });
    } else {
      searchAbortRef.current?.abort();
      document.body.style.overflow = "";
      setTimeout(() => {
        setQuery("");
        setResults(null);
        setHasSearched(false);
        setIsLoading(false);
        setSearchError(null);
      }, 200);
      previousFocusRef.current?.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      searchAbortRef.current?.abort();
      setIsLoading(false);
      return;
    }

    if (!normalizedQuery) {
      searchAbortRef.current?.abort();
      setResults(null);
      setIsLoading(false);
      setHasSearched(false);
      setSearchError(null);
      return;
    }

    const cachedResults = searchResultCache.get(getSearchCacheKey(normalizedQuery));
    if (cachedResults) {
      searchAbortRef.current?.abort();
      setResults(cachedResults);
      setSelectedIndex(0);
      setHasSearched(true);
      setIsLoading(false);
      setSearchError(null);
      return;
    }

    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    const runId = searchRunRef.current + 1;
    searchRunRef.current = runId;
    // Never leave results from the previous query selectable while the next
    // request is pending. Cached queries still replace the list immediately.
    setResults(null);
    setHasSearched(false);
    setSelectedIndex(0);
    setIsLoading(true);
    setSearchError(null);

    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          q: normalizedQuery,
          limit: PREDICTIVE_SEARCH_RESULT_LIMIT,
          searchCategories: "true",
          searchPages: "true",
        });

        const res = await fetch(createApiUrl(`/search?${params}`), {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error("Search failed");

        const json = (await res.json()) as ApiResponse;
        if (controller.signal.aborted || searchRunRef.current !== runId) return;

        if (json.success && json.data) {
          cacheSearchResults(normalizedQuery, json.data);
          setResults(json.data);
          setSelectedIndex(0);
          setHasSearched(true);
        } else {
          throw new Error("Search response was invalid");
        }
      } catch (error: unknown) {
        if (isAbortError(error)) return;
        console.error("Search error:", error);
        if (searchRunRef.current === runId) {
          setResults(null);
          setHasSearched(true);
          setSearchError("Search is temporarily unavailable.");
        }
      } finally {
        if (searchRunRef.current === runId) {
          setIsLoading(false);
        }
      }
    }, PREDICTIVE_SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [isOpen, normalizedQuery, searchRetry]);

  useEffect(() => {
    if (!isOpen) return;
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !modalRef.current) return;
      const focusable = Array.from(
        modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trapFocus);
    return () => document.removeEventListener("keydown", trapFocus);
  }, [isOpen]);

  const handleNavigation = useCallback(
    (e: React.KeyboardEvent) => {
      if (flatResults.length === 0) {
        if (e.key === "Enter" && normalizedQuery) {
          window.location.href = `/search?q=${encodeURIComponent(normalizedQuery)}`;
        }
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        const nextIndex = (selectedIndex + 1) % flatResults.length;
        setSelectedIndex(nextIndex);
        document
          .getElementById(`cmd-item-${nextIndex}`)
          ?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const nextIndex =
          (selectedIndex - 1 + flatResults.length) % flatResults.length;
        setSelectedIndex(nextIndex);
        document
          .getElementById(`cmd-item-${nextIndex}`)
          ?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        e.preventDefault();
        const selected = flatResults[selectedIndex];
        navigateToItem(selected);
      }
    },
    [flatResults, selectedIndex, normalizedQuery],
  );

  const navigateToItem = (entry: { type: string; item: SearchResultItem }) => {
    if (!entry) return;
    const { type, item } = entry;
    if (type === "product") window.location.href = `/products/${item.slug}`;
    else if (type === "category")
      window.location.href = `/categories/${item.slug}`;
    else if (type === "page") window.location.href = `/${item.slug}`;
  };

  // Mobile: Close on empty click
  const handleEmptyClick = () => {
    // Only close if on mobile (screen width check or logic) and no query
    if (window.innerWidth < 640 && !query) {
      setIsOpen(false);
    }
  };

  if (!mounted || !isOpen) return null;

  const searchStatus = isLoading
    ? "Searching…"
    : searchError
      ? "Search unavailable"
      : hasSearched
        ? `${flatResults.length} ${flatResults.length === 1 ? "result" : "results"}`
        : "";

  return createPortal(
    <div className="fixed inset-0 z-100 flex items-start justify-center sm:pt-[10vh]">
      <div
        aria-hidden="true"
        className="fixed inset-0 bg-background/80 backdrop-blur-md transition-opacity animate-in fade-in duration-200 sm:bg-black/40"
        onClick={() => setIsOpen(false)}
      />

      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search catalog"
        className={cn(
          "relative flex w-full flex-col overflow-hidden bg-background text-foreground shadow-2xl transition-all",
          "h-dvh rounded-none",
          "sm:mx-4 sm:h-auto sm:max-h-[80vh] sm:max-w-3xl sm:rounded-2xl sm:border sm:border-border sm:ring-1 sm:ring-black/5",
          "animate-in sm:zoom-in-95 sm:slide-in-from-bottom-4 fade-in duration-200",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="relative z-10 flex shrink-0 items-center gap-3 border-b border-border bg-background px-4 py-3 sm:py-4">
          <div className="relative flex-1 flex items-center">
            <Search
              className={cn(
                "absolute left-0 w-5 h-5 transition-colors pointer-events-none",
                isLoading ? "text-primary" : "text-muted-foreground",
              )}
            />

            <input
              ref={inputRef}
              type="text"
              className="h-11 w-full border-none bg-transparent pl-8 pr-8 text-lg font-medium tracking-tight text-foreground outline-none placeholder:text-muted-foreground sm:text-xl"
              placeholder="Search products…"
              aria-label="Search products"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleNavigation}
              autoFocus
              autoComplete="off"
              autoCapitalize="none"
              maxLength={120}
              inputMode="search"
              enterKeyHint="search"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={flatResults.length > 0}
              aria-controls="catalog-search-results"
              aria-activedescendant={
                flatResults.length > 0 ? `cmd-item-${selectedIndex}` : undefined
              }
            />

            {/* Loader Inside Input (No shifting) */}
            {isLoading && (
              <div className="absolute right-0 top-1/2 -translate-y-1/2">
                <Loader2 className="w-4 h-4 text-primary animate-spin" />
              </div>
            )}
          </div>

          <span className="sr-only" role="status" aria-live="polite">
            {searchStatus}
          </span>

          {/* Stable Close Button */}
          <button
            type="button"
            aria-label="Close search"
            onClick={() => setIsOpen(false)}
            className="min-h-11 min-w-11 shrink-0 rounded-lg bg-muted px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground active:scale-95"
          >
            <span className="sm:hidden">Cancel</span>
            <span className="hidden sm:inline">
              <X className="w-5 h-5" />
            </span>
          </button>
        </div>

        {/* Results List */}
        <div
          id="catalog-search-results"
          role="listbox"
          aria-busy={isLoading}
          className="scrollbar-hide min-h-0 flex-1 overflow-y-auto bg-muted/30 p-0 sm:bg-background sm:p-2"
          onClick={handleEmptyClick}
        >
          {isLoading && normalizedQuery && (
            <div
              className="space-y-2 px-4 py-5 sm:px-3"
              aria-hidden="true"
            >
              <p className="pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Searching…
              </p>
              {[0, 1, 2].map((index) => (
                <div
                  key={index}
                  className="flex min-h-16 items-center gap-3 rounded-lg bg-background px-3 py-2 sm:bg-muted/50"
                >
                  <span className="h-10 w-10 shrink-0 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                  <span className="flex-1 space-y-2">
                    <span className="block h-3 w-2/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                    <span className="block h-2.5 w-1/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* State: Empty/Start */}
          {!normalizedQuery && (
            <div className="pointer-events-none flex h-full flex-col items-center justify-center py-24 text-muted-foreground sm:py-20">
              <div className="mb-4 rounded-full bg-muted/50 p-4">
                <Search className="w-6 h-6 opacity-20" />
              </div>
              <p className="text-sm font-medium text-muted-foreground">
                Search products, categories, and pages
              </p>
            </div>
          )}

          {/* State: No Results */}
          {searchError && !isLoading && (
            <div
              className="flex h-full flex-col items-center justify-center py-24 text-muted-foreground sm:py-20"
              role="alert"
            >
              <AlertCircle className="mb-3 h-8 w-8 text-destructive opacity-40" />
              <p className="font-medium text-foreground">Search unavailable</p>
              <button
                type="button"
                className="mt-4 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
                onClick={() => setSearchRetry((value) => value + 1)}
              >
                Retry
              </button>
            </div>
          )}

          {hasSearched && !isLoading && !searchError && flatResults.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center py-24 text-muted-foreground sm:py-20">
              <AlertCircle className="mb-3 h-8 w-8 text-destructive opacity-20" />
              <p className="font-medium text-foreground">No results found</p>
              <p className="text-sm mt-1">Try a different keyword</p>
            </div>
          )}

          {/* State: Results */}
          {results && (
            <div className="space-y-4 pb-4 sm:pt-2">
              {/* Products */}
              {results.products.length > 0 && (
                <div>
                  <h3 className="sticky top-0 z-10 bg-muted/50 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground sm:static sm:bg-transparent">
                    Products
                  </h3>
                  <div className="grid grid-cols-1 gap-0 sm:gap-1">
                    {results.products.map((p) => {
                      const activeIdx = flatResults.findIndex(
                        (f) => f.item.id === p.id && f.type === "product",
                      );
                      return (
                        <ResultRow
                          key={p.id}
                          active={activeIdx === selectedIndex}
                          onClick={() =>
                            navigateToItem({ type: "product", item: p })
                          }
                          id={`cmd-item-${activeIdx}`}
                        >
                          <ProductThumbnail product={p} active={activeIdx === selectedIndex} />
                          <div className="flex-1 min-w-0">
                            <div className="truncate text-sm font-medium text-foreground">
                              {p.name}
                            </div>
                            <div className="text-xs font-medium text-muted-foreground">
                              {p.discountedPrice !== undefined ? (
                                <span className="text-primary">
                                  {p.priceVaries ? "From " : ""}
                                  {getCurrencySymbol()}
                                  {p.discountedPrice.toLocaleString()}
                                </span>
                              ) : (
                                <span>
                                  {getCurrencySymbol()}
                                  {p.price?.toLocaleString()}
                                </span>
                              )}
                            </div>
                            {p.availableForSale === false ? (
                              <div className="mt-0.5 text-[11px] font-medium text-muted-foreground">
                                Sold out
                              </div>
                            ) : null}
                          </div>
                          <ChevronRight
                            className={cn(
                              "h-4 w-4 text-muted-foreground/50 transition-transform",
                              activeIdx === selectedIndex
                                ? "translate-x-0 text-primary"
                                : "-translate-x-2 opacity-0 sm:block hidden",
                            )}
                          />
                        </ResultRow>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Categories */}
              {results.categories.length > 0 && (
                <div>
                  <h3 className="sticky top-0 z-10 bg-muted/50 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground sm:static sm:bg-transparent">
                    Categories
                  </h3>
                  <div
                    className={cn(
                      "grid grid-cols-1 gap-1",
                      results.categories.length > 1 && "sm:grid-cols-2",
                    )}
                  >
                    {results.categories.map((c) => {
                      const activeIdx = flatResults.findIndex(
                        (f) => f.item.id === c.id && f.type === "category",
                      );
                      return (
                        <ResultRow
                          key={c.id}
                          active={activeIdx === selectedIndex}
                          onClick={() =>
                            navigateToItem({ type: "category", item: c })
                          }
                          id={`cmd-item-${activeIdx}`}
                        >
                          <div className="h-8 w-8 rounded bg-primary/10 flex items-center justify-center mr-3 shrink-0 text-primary">
                            <Layers className="h-4 w-4" />
                          </div>
                          <span className="font-medium text-foreground text-sm">
                            {c.name}
                          </span>
                        </ResultRow>
                      );
                    })}
                  </div>
                </div>
              )}

              {results.pages.length > 0 && (
                <div>
                  <h3 className="sticky top-0 z-10 bg-muted/50 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground sm:static sm:bg-transparent">
                    Pages
                  </h3>
                  <div
                    className={cn(
                      "grid grid-cols-1 gap-1",
                      results.pages.length > 1 && "sm:grid-cols-2",
                    )}
                  >
                    {results.pages.map((page) => {
                      const activeIdx = flatResults.findIndex(
                        (result) => result.item.id === page.id && result.type === "page",
                      );
                      return (
                        <ResultRow
                          key={page.id}
                          active={activeIdx === selectedIndex}
                          onClick={() => navigateToItem({ type: "page", item: page })}
                          id={`cmd-item-${activeIdx}`}
                        >
                          <div className="mr-3 flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                            <FileText className="h-4 w-4" />
                          </div>
                          <span className="font-medium text-foreground text-sm truncate">
                            {page.title}
                          </span>
                        </ResultRow>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {normalizedQuery && (
          <a
            href={`/search?q=${encodeURIComponent(normalizedQuery)}`}
            className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-t border-border bg-background px-4 text-sm font-medium text-foreground sm:hidden"
          >
            <span className="truncate">View all results for “{normalizedQuery}”</span>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </a>
        )}

        {/* Desktop keyboard help and full-results link */}
        <div className="hidden shrink-0 items-center justify-between border-t border-border bg-muted/30 px-5 py-3 text-xs text-muted-foreground sm:flex">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5">
              <kbd className="flex h-5 min-w-5 items-center justify-center rounded border border-border bg-background px-1 font-sans text-[10px] shadow-sm">
                ↵
              </kbd>
              <span>to select</span>
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className="flex h-5 min-w-5 items-center justify-center rounded border border-border bg-background px-1 font-sans text-[10px] shadow-sm">
                ↑↓
              </kbd>
              <span>to navigate</span>
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className="flex h-5 min-w-5 items-center justify-center rounded border border-border bg-background px-1 font-sans text-[10px] shadow-sm">
                esc
              </kbd>
              <span>to close</span>
            </span>
          </div>

          {normalizedQuery && (
            <a
              href={`/search?q=${encodeURIComponent(normalizedQuery)}`}
              className="flex items-center hover:text-primary transition-colors ml-auto font-medium"
            >
              View all results <ArrowRight className="w-3 h-3 ml-1" />
            </a>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ProductThumbnail({
  product,
  active,
}: {
  product: SearchResultItem;
  active: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const hasImage = hasProductImage(product.imageUrl) && !failed;

  return (
    <div className="relative mr-3 flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-background p-0.5">
      {hasImage && !loaded ? (
        <span
          className="h-5 w-5 animate-pulse rounded bg-muted motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : null}
      {hasImage ? (
        <img
          src={getProductImageUrl(product.imageUrl, {
            width: 80,
            height: 80,
            quality: 75,
            format: "auto",
            fit: "contain",
          })}
          alt={product.imageAlt || product.name || ""}
          width={40}
          height={40}
          decoding="async"
          fetchPriority={active ? "high" : "auto"}
          className={cn(
            "h-full w-full object-contain transition-opacity duration-150 motion-reduce:transition-none",
            loaded ? "opacity-100" : "absolute inset-0 opacity-0",
          )}
          onLoad={() => setLoaded(true)}
          onError={() => {
            setLoaded(false);
            setFailed(true);
          }}
        />
      ) : (
        <Package className="h-4 w-4 text-muted-foreground/50" aria-hidden="true" />
      )}
    </div>
  );
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

function ResultRow({
  active,
  children,
  onClick,
  id,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
  id: string;
}) {
  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex w-full cursor-pointer items-center border-b border-border/50 px-4 py-3 text-left transition-all duration-150 sm:mx-2 sm:rounded-lg sm:border-none",
        active ? "bg-muted" : "bg-background hover:bg-muted/50",
      )}
    >
      {children}
    </button>
  );
}
