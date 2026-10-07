/** The theme history's query keys and version reads, apart from the history sheet (loaded when opened). */
import { getApiV1AdminSettingsThemeDocument } from "@scalius/api-client/sdk";
import type { StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import { apiData } from "~/lib/api";

export const themeVersionsKey = ["theme-versions"] as const;

/** One published version's document, cached by revision (preview and compare share it). */
export const themeVersionDocumentQuery = (revision: number | null) => ({
  queryKey: [...themeVersionsKey, "document", revision] as const,
  queryFn: async () => (await apiData(getApiV1AdminSettingsThemeDocument({ query: { source: "version", revision: revision! } }))).document as StorefrontThemeDocument,
  enabled: revision !== null,
  staleTime: Infinity,
});
