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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getCurrencySymbol } from "@/lib/currency";

interface SearchResultItem {
  id: string;
  name?: string;
  title?: string;
  slug: string;
  price?: number;
  imageUrl?: string;
  discountedPrice?: number;
}

interface SearchResponse {
  products: SearchResultItem[];
  categories: SearchResultItem[];
  pages: SearchResultItem[];
  success: boolean;
}

export default function CommandPalette() {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

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
      document.body.style.overflow = "hidden";
      setSelectedIndex(0);
      requestAnimationFrame(() => {
        setTimeout(() => inputRef.current?.focus(), 50);
      });
    } else {
      document.body.style.overflow = "";
      setTimeout(() => {
        setQuery("");
        setResults(null);
        setHasSearched(false);
        setIsLoading(false);
      }, 200);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!query.trim()) {
      setResults(null);
      setIsLoading(false);
      setHasSearched(false);
      return;
    }

    setIsLoading(true);

    const timer = setTimeout(async () => {
      try {
        const apiBaseUrl = import.meta.env.PUBLIC_API_URL || "/api/v1";
        const params = new URLSearchParams({
          q: query,
          limit: "8",
          searchCategories: "true",
          searchPages: "true",
        });

        const res = await fetch(`${apiBaseUrl}/search?${params}`);
        if (!res.ok) throw new Error("Search failed");

        const data = (await res.json()) as SearchResponse;

        if (data.success) {
          setResults(data);
          setSelectedIndex(0);
          setHasSearched(true);
        }
      } catch (error) {
        console.error("Search error:", error);
      } finally {
        setIsLoading(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query]);

  const handleNavigation = useCallback(
    (e: React.KeyboardEvent) => {
      if (flatResults.length === 0) {
        if (e.key === "Enter" && query.trim()) {
          window.location.href = `/search?q=${encodeURIComponent(query)}`;
        }
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % flatResults.length);
        const nextIndex = (selectedIndex + 1) % flatResults.length;
        document
          .getElementById(`cmd-item-${nextIndex}`)
          ?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(
          (prev) => (prev - 1 + flatResults.length) % flatResults.length,
        );
        const nextIndex =
          (selectedIndex - 1 + flatResults.length) % flatResults.length;
        document
          .getElementById(`cmd-item-${nextIndex}`)
          ?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        e.preventDefault();
        const selected = flatResults[selectedIndex];
        navigateToItem(selected);
      }
    },
    [flatResults, selectedIndex, query],
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

  return createPortal(
    <div className="fixed inset-0 z-100 flex items-start justify-center sm:pt-[10vh]">
      {/* Desktop Backdrop */}
      <div
        className="fixed inset-0 bg-white/80 sm:bg-black/40 backdrop-blur-md transition-opacity animate-in fade-in duration-200"
        onClick={() => setIsOpen(false)}
      />

      {/* Modal Container */}
      <div
        className={cn(
          "relative w-full bg-white overflow-hidden flex flex-col shadow-2xl transition-all",
          "h-dvh rounded-none",
          "sm:h-auto sm:max-h-[80vh] sm:max-w-3xl sm:rounded-2xl sm:border sm:border-gray-200/50 sm:ring-1 sm:ring-black/5 sm:mx-4",
          "animate-in sm:zoom-in-95 sm:slide-in-from-bottom-4 fade-in duration-200",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center px-4 py-3 sm:py-5 border-b border-gray-100 shrink-0 gap-3 bg-white relative z-10">
          <div className="relative flex-1 flex items-center">
            <Search
              className={cn(
                "absolute left-0 w-5 h-5 transition-colors pointer-events-none",
                isLoading ? "text-primary" : "text-gray-400",
              )}
            />

            <input
              ref={inputRef}
              type="text"
              className="w-full bg-transparent border-none outline-none text-lg sm:text-xl text-gray-900 placeholder:text-gray-400 font-medium h-10 tracking-tight pl-8 pr-8"
              placeholder="Search products..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleNavigation}
              autoFocus
              enterKeyHint="search"
            />

            {/* Loader Inside Input (No shifting) */}
            {isLoading && (
              <div className="absolute right-0 top-1/2 -translate-y-1/2">
                <Loader2 className="w-4 h-4 text-primary animate-spin" />
              </div>
            )}
          </div>

          {/* Stable Close Button */}
          <button
            onClick={() => setIsOpen(false)}
            className="shrink-0 text-sm font-medium text-gray-500 hover:text-black px-3 py-2 bg-gray-100 rounded-lg transition-colors active:scale-95"
          >
            <span className="sm:hidden">Cancel</span>
            <span className="hidden sm:inline">
              <X className="w-5 h-5" />
            </span>
          </button>
        </div>

        {/* Results List */}
        <div
          className="overflow-y-auto p-0 sm:p-2 scrollbar-hide flex-1 min-h-0 bg-gray-50/50 sm:bg-white"
          onClick={handleEmptyClick}
        >
          {/* State: Empty/Start */}
          {!query && (
            <div className="flex flex-col items-center justify-center h-full text-gray-400 py-24 sm:py-20 pointer-events-none">
              <div className="p-4 bg-gray-50 rounded-full mb-4">
                <Search className="w-6 h-6 opacity-20" />
              </div>
              <p className="text-sm font-medium text-gray-500">
                Type to search...
              </p>
            </div>
          )}

          {/* State: No Results */}
          {hasSearched && !isLoading && flatResults.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-gray-500 py-24 sm:py-20">
              <AlertCircle className="w-8 h-8 opacity-20 mb-3 text-red-500" />
              <p className="text-gray-900 font-medium">No results found</p>
              <p className="text-sm mt-1">Try a different keyword</p>
            </div>
          )}

          {/* State: Results */}
          {results && (
            <div className="space-y-4 pb-4 sm:pt-2">
              {/* Products */}
              {results.products.length > 0 && (
                <div>
                  <h3 className="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider bg-gray-100/50 sm:bg-transparent sticky top-0 z-10 sm:static">
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
                          <div className="h-10 w-10 rounded bg-white p-0.5 border border-gray-100 mr-3 overflow-hidden shrink-0">
                            {p.imageUrl ? (
                              <img
                                src={p.imageUrl}
                                alt={p.name}
                                className="h-full w-full object-contain"
                              />
                            ) : (
                              <Package className="h-4 w-4 text-gray-300 m-auto mt-2" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-gray-900 truncate text-sm">
                              {p.name}
                            </div>
                            <div className="text-xs text-gray-500 font-medium">
                              {p.discountedPrice ? (
                                <span className="text-primary">
                                  {getCurrencySymbol()}{p.discountedPrice.toLocaleString()}
                                </span>
                              ) : (
                                <span>{getCurrencySymbol()}{p.price?.toLocaleString()}</span>
                              )}
                            </div>
                          </div>
                          <ChevronRight
                            className={cn(
                              "w-4 h-4 text-gray-300 transition-transform",
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
                  <h3 className="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider bg-gray-100/50 sm:bg-transparent sticky top-0 z-10 sm:static">
                    Categories
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
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
            </div>
          )}
        </div>

        {/* Footer (Restored) */}
        <div className="hidden sm:flex px-5 py-3 bg-gray-50 border-t border-gray-100 items-center justify-between text-xs text-gray-400 shrink-0">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5">
              <kbd className="h-5 min-w-5 px-1 flex items-center justify-center bg-white border border-gray-200 rounded text-[10px] font-sans shadow-sm">
                ↵
              </kbd>
              <span>to select</span>
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className="h-5 min-w-5 px-1 flex items-center justify-center bg-white border border-gray-200 rounded text-[10px] font-sans shadow-sm">
                ↑↓
              </kbd>
              <span>to navigate</span>
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className="h-5 min-w-5 px-1 flex items-center justify-center bg-white border border-gray-200 rounded text-[10px] font-sans shadow-sm">
                esc
              </kbd>
              <span>to close</span>
            </span>
          </div>

          {query && (
            <a
              href={`/search?q=${encodeURIComponent(query)}`}
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
    <div
      id={id}
      onClick={onClick}
      className={cn(
        "flex items-center px-4 py-3 cursor-pointer transition-all duration-150 border-b border-gray-50 sm:border-none sm:rounded-lg sm:mx-2",
        active ? "bg-muted" : "bg-white hover:bg-muted/50",
      )}
    >
      {children}
    </div>
  );
}
