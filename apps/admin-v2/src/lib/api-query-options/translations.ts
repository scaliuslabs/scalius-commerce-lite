// Settings › Languages and Translate & adapt (docs/MARKETS-DESIGN.md D9): the
// store's languages, each translatable resource with its translation in a
// language and market, saves and machine translation through an app.
import { keepPreviousData, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  deleteApiV1AdminSettingsLanguagesByLocale,
  deleteApiV1AdminTranslationsByTypeById,
  getApiV1AdminSettingsLanguages,
  getApiV1AdminTranslationsByTypeById,
  getApiV1AdminTranslationsProviders,
  getApiV1AdminTranslationsResources,
  patchApiV1AdminSettingsLanguagesByLocale,
  postApiV1AdminSettingsLanguages,
  postApiV1AdminTranslationsMachine,
  putApiV1AdminTranslationsByTypeById,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody, type ApiResult } from "../api";

export type StoreLanguage = ApiResult<typeof getApiV1AdminSettingsLanguages>["items"][number];
export type TranslatableResource = ApiResult<typeof getApiV1AdminTranslationsByTypeById>["resource"];
export type ResourceTranslationsView = ApiResult<typeof getApiV1AdminTranslationsByTypeById>;
export type TranslationResourcePage = ApiResult<typeof getApiV1AdminTranslationsResources>;
export type SaveTranslationBody = ApiBody<typeof putApiV1AdminTranslationsByTypeById>;
export type TranslationProvider = ApiResult<typeof getApiV1AdminTranslationsProviders>["items"][number];

import { STORE_LANGUAGES_QUERY_KEY, type TranslationEditorType } from "../translation-types";

export { TRANSLATION_EDITOR_TYPES, isTranslationEditorType, type TranslationEditorType } from "../translation-types";

export const translationKeys = {
  all: ["translations"] as const,
  languages: () => STORE_LANGUAGES_QUERY_KEY,
  providers: () => [...translationKeys.all, "providers"] as const,
  resources: (input: { type: string; locale: string; marketId: string | null; search: string; page: number }) =>
    [...translationKeys.all, "resources", input] as const,
  resource: (type: string, id: string, locale: string, marketId: string | null) =>
    [...translationKeys.all, "resource", type, id, locale, marketId] as const,
};

/** The store's languages, the default first. */
export const storeLanguagesQueryOptions = () =>
  queryOptions({
    queryKey: translationKeys.languages(),
    queryFn: async () => (await apiData(getApiV1AdminSettingsLanguages())).items,
    staleTime: 30_000,
  });

/** Machine translation providers of active apps, and the source (default) language. */
export const translationProvidersQueryOptions = () =>
  queryOptions({
    queryKey: translationKeys.providers(),
    queryFn: async () => apiData(getApiV1AdminTranslationsProviders()),
    staleTime: 60_000,
  });

export const translationResourcesQueryOptions = (input: {
  type: TranslationEditorType;
  locale: string;
  marketId: string | null;
  search: string;
  page: number;
}) =>
  queryOptions({
    queryKey: translationKeys.resources(input),
    queryFn: async () => apiData(getApiV1AdminTranslationsResources({
      query: {
        type: input.type,
        locale: input.locale,
        ...(input.marketId ? { marketId: input.marketId } : {}),
        ...(input.search ? { search: input.search } : {}),
        page: input.page,
        limit: 25,
      },
    })),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });

export const resourceTranslationsQueryOptions = (type: TranslationEditorType, id: string, locale: string, marketId: string | null) =>
  queryOptions({
    queryKey: translationKeys.resource(type, id, locale, marketId),
    queryFn: async () => apiData(getApiV1AdminTranslationsByTypeById({
      path: { type, id },
      query: { locale, ...(marketId ? { marketId } : {}) },
    })),
    staleTime: 0,
  });

function useRefreshTranslations() {
  const queryClient = useQueryClient();
  return () => Promise.all([
    queryClient.invalidateQueries({ queryKey: [...translationKeys.all, "resources"] }),
    queryClient.invalidateQueries({ queryKey: translationKeys.languages() }),
  ]);
}

export function useSaveTranslation(type: TranslationEditorType, id: string) {
  const queryClient = useQueryClient();
  const refresh = useRefreshTranslations();
  return useMutation({
    mutationFn: async (body: SaveTranslationBody) => apiData(putApiV1AdminTranslationsByTypeById({ path: { type, id }, body })),
    onSuccess: (view, body) => {
      queryClient.setQueryData(translationKeys.resource(type, id, body.locale, body.marketId ?? null), view);
    },
    onSettled: () => refresh(),
  });
}

export function useDeleteTranslation(type: TranslationEditorType, id: string) {
  const queryClient = useQueryClient();
  const refresh = useRefreshTranslations();
  return useMutation({
    mutationFn: async (input: { locale: string; marketId: string | null }) =>
      apiData(deleteApiV1AdminTranslationsByTypeById({
        path: { type, id },
        query: { locale: input.locale, ...(input.marketId ? { marketId: input.marketId } : {}) },
      })),
    onSettled: (_data, _error, input) => Promise.all([
      refresh(),
      queryClient.invalidateQueries({ queryKey: translationKeys.resource(type, id, input.locale, input.marketId) }),
    ]),
  });
}

export function useMachineTranslate() {
  return useMutation({
    mutationFn: async (body: ApiBody<typeof postApiV1AdminTranslationsMachine>) =>
      (await apiData(postApiV1AdminTranslationsMachine({ body }))).texts,
  });
}

function useRefreshLanguages() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: translationKeys.languages() });
}

export function useAddStoreLanguage() {
  const refresh = useRefreshLanguages();
  return useMutation({
    mutationFn: async (body: ApiBody<typeof postApiV1AdminSettingsLanguages>) =>
      (await apiData(postApiV1AdminSettingsLanguages({ body }))).language,
    onSettled: refresh,
  });
}

export function useUpdateStoreLanguage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { locale: string; published?: boolean; isDefault?: true }) =>
      (await apiData(patchApiV1AdminSettingsLanguagesByLocale({
        path: { locale: input.locale },
        body: {
          ...(input.published === undefined ? {} : { published: input.published }),
          ...(input.isDefault ? { isDefault: true as const } : {}),
        },
      }))).language,
    // The default language moves the markets' root presence and the checkout copy in use.
    onSettled: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: translationKeys.languages() }),
      queryClient.invalidateQueries({ queryKey: ["settings", "markets"] }),
    ]),
  });
}

export function useRemoveStoreLanguage() {
  const refresh = useRefreshLanguages();
  return useMutation({
    mutationFn: async (locale: string) => apiData(deleteApiV1AdminSettingsLanguagesByLocale({ path: { locale } })),
    onSettled: refresh,
  });
}
