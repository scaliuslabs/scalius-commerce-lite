import { map } from "nanostores";

interface SuggestionState {
  suggestions: string[];
  isLoading: boolean;
  showSuggestions: boolean;
  activeInputId: string | null;
}

// Global store for attribute suggestions
export const suggestionsStore = map<SuggestionState>({
  suggestions: [],
  isLoading: false,
  showSuggestions: false,
  activeInputId: null,
});

// Cache for suggestions to avoid repeated API calls
const suggestionsCache = new Map<string, string[]>();

// Debounce helper
let debounceTimer: NodeJS.Timeout | null = null;

export const suggestionsActions = {
  // Set loading state for a specific input
  setLoading: (inputId: string, isLoading: boolean) => {
    const current = suggestionsStore.get();
    if (current.activeInputId === inputId) {
      suggestionsStore.setKey("isLoading", isLoading);
    }
  },

  // Set active input and show/hide suggestions
  setActiveInput: (inputId: string | null) => {
    suggestionsStore.setKey("activeInputId", inputId);
    if (!inputId) {
      suggestionsStore.setKey("showSuggestions", false);
      suggestionsStore.setKey("suggestions", []);
    }
  },

  // Show suggestions for active input
  showSuggestions: (inputId: string) => {
    const current = suggestionsStore.get();
    if (current.activeInputId === inputId && current.suggestions.length > 0) {
      suggestionsStore.setKey("showSuggestions", true);
    }
  },

  // Hide suggestions
  hideSuggestions: () => {
    suggestionsStore.setKey("showSuggestions", false);
  },

  // Clear all suggestions
  clearSuggestions: () => {
    suggestionsStore.set({
      suggestions: [],
      isLoading: false,
      showSuggestions: false,
      activeInputId: null,
    });
  },

  // Fetch suggestions with debouncing
  fetchSuggestions: async (inputId: string, query: string) => {
    // Clear previous debounce
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    return new Promise<void>((resolve) => {
      debounceTimer = setTimeout(async () => {
        try {
          // Check if this input is still active
          const current = suggestionsStore.get();
          if (current.activeInputId !== inputId) {
            resolve();
            return;
          }

          if (!query.trim() || query.length < 1) {
            suggestionsStore.setKey("suggestions", []);
            suggestionsStore.setKey("showSuggestions", false);
            resolve();
            return;
          }

          // Check cache first
          const cacheKey = query.toLowerCase().trim();
          if (suggestionsCache.has(cacheKey)) {
            const cachedSuggestions = suggestionsCache.get(cacheKey) || [];
            const filteredSuggestions = cachedSuggestions
              .filter(
                (value) =>
                  value.toLowerCase() !== query.toLowerCase() &&
                  value.toLowerCase().includes(query.toLowerCase()),
              )
              .slice(0, 8);

            suggestionsStore.setKey("suggestions", filteredSuggestions);
            suggestionsStore.setKey(
              "showSuggestions",
              filteredSuggestions.length > 0,
            );
            resolve();
            return;
          }

          // Set loading state
          suggestionsActions.setLoading(inputId, true);

          // Fetch from API
          const response = await fetch(
            `/api/admin/attributes/values/search?q=${encodeURIComponent(query.trim())}&limit=10`,
          );

          // Check if this input is still active after API call
          const currentAfterFetch = suggestionsStore.get();
          if (currentAfterFetch.activeInputId !== inputId) {
            resolve();
            return;
          }

          if (response.ok) {
            const data = await response.json();
            const values = data.values || [];

            // Cache the results
            suggestionsCache.set(cacheKey, values);

            const filteredSuggestions = values
              .filter(
                (value: string) =>
                  value.toLowerCase() !== query.toLowerCase() &&
                  value.toLowerCase().includes(query.toLowerCase()),
              )
              .slice(0, 8);

            suggestionsStore.setKey("suggestions", filteredSuggestions);
            suggestionsStore.setKey(
              "showSuggestions",
              filteredSuggestions.length > 0,
            );
          } else {
            suggestionsStore.setKey("suggestions", []);
            suggestionsStore.setKey("showSuggestions", false);
          }
        } catch (error) {
          console.error("Failed to fetch suggestions:", error);
          suggestionsStore.setKey("suggestions", []);
          suggestionsStore.setKey("showSuggestions", false);
        } finally {
          suggestionsActions.setLoading(inputId, false);
          resolve();
        }
      }, 300);
    });
  },

  // Select a suggestion
  selectSuggestion: (suggestion: string, onSelect: (value: string) => void) => {
    onSelect(suggestion);
    suggestionsStore.setKey("showSuggestions", false);
    suggestionsStore.setKey("suggestions", []);
  },
};

// Clean up cache periodically (every 5 minutes)
setInterval(
  () => {
    if (suggestionsCache.size > 100) {
      suggestionsCache.clear();
    }
  },
  5 * 60 * 1000,
);
