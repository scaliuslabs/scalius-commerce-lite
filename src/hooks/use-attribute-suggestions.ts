import { useState, useEffect, useCallback, useRef } from "react";
import { useDebounce } from "./use-debounce";

interface UseAttributeSuggestionsProps {
  searchValue: string;
  onSuggestionSelect: (value: string) => void;
}

export function useAttributeSuggestions({
  searchValue,
  onSuggestionSelect,
}: UseAttributeSuggestionsProps) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const debouncedSearchValue = useDebounce(searchValue, 300);
  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchSuggestions = useCallback(async (query: string) => {
    if (!query.trim() || query.length < 1) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    // Cancel previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsLoading(true);
    try {
      const response = await fetch(
        `/api/admin/attributes/values/search?q=${encodeURIComponent(query.trim())}&limit=10`,
        { signal: controller.signal },
      );

      if (response.ok) {
        const data = await response.json();
        const values = data.values || [];
        const filteredSuggestions = values
          .filter(
            (value: string) =>
              value.toLowerCase() !== query.toLowerCase() &&
              value.toLowerCase().includes(query.toLowerCase()),
          )
          .slice(0, 8);

        setSuggestions(filteredSuggestions);
        setShowSuggestions(filteredSuggestions.length > 0);
      } else {
        setSuggestions([]);
        setShowSuggestions(false);
      }
    } catch (error: any) {
      if (error.name !== "AbortError") {
        console.error("Failed to fetch suggestions:", error);
        setSuggestions([]);
        setShowSuggestions(false);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSuggestions(debouncedSearchValue);
  }, [debouncedSearchValue, fetchSuggestions]);

  const handleSuggestionClick = useCallback(
    (suggestion: string) => {
      onSuggestionSelect(suggestion);
      setShowSuggestions(false);
      setSuggestions([]);
    },
    [onSuggestionSelect],
  );

  const handleFocus = useCallback(() => {
    if (suggestions.length > 0) {
      setShowSuggestions(true);
    }
  }, [suggestions.length]);

  const handleBlur = useCallback(() => {
    // Delay hiding to allow click events
    setTimeout(() => {
      setShowSuggestions(false);
    }, 200);
  }, []);

  const hideSuggestions = useCallback(() => {
    setShowSuggestions(false);
    setSuggestions([]);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  return {
    suggestions,
    isLoading,
    showSuggestions,
    handleSuggestionClick,
    handleFocus,
    handleBlur,
    hideSuggestions,
  };
}
