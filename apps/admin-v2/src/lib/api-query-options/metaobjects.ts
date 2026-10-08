// Content types (metaobjects): the types a merchant or an app defines and
// their entries. Every write carries the revision the caller read; the API
// answers 409 `METAOBJECT_REVISION_CONFLICT` when it is stale.
import { keepPreviousData, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  deleteApiV1AdminMetaobjectsDefinitionsById,
  deleteApiV1AdminMetaobjectsDefinitionsByIdEntriesByEntryId,
  getApiV1AdminMetaobjectsDefinitions,
  getApiV1AdminMetaobjectsDefinitionsById,
  getApiV1AdminMetaobjectsDefinitionsByIdEntries,
  getApiV1AdminMetaobjectsDefinitionsByIdEntriesByEntryId,
  patchApiV1AdminMetaobjectsDefinitionsById,
  patchApiV1AdminMetaobjectsDefinitionsByIdEntriesByEntryId,
  postApiV1AdminMetaobjectsDefinitions,
  postApiV1AdminMetaobjectsDefinitionsByIdEntries,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody, type ApiResult } from "../api";

export type MetaobjectDefinition = ApiResult<typeof getApiV1AdminMetaobjectsDefinitionsById>["definition"];
export type MetaobjectField = MetaobjectDefinition["fields"][number];
export type MetaobjectEntry = ApiResult<typeof getApiV1AdminMetaobjectsDefinitionsByIdEntriesByEntryId>["entry"];
export type CreateMetaobjectDefinitionBody = ApiBody<typeof postApiV1AdminMetaobjectsDefinitions>;
export type UpdateMetaobjectDefinitionBody = ApiBody<typeof patchApiV1AdminMetaobjectsDefinitionsById>;
export type CreateMetaobjectEntryBody = ApiBody<typeof postApiV1AdminMetaobjectsDefinitionsByIdEntries>;
export type UpdateMetaobjectEntryBody = ApiBody<typeof patchApiV1AdminMetaobjectsDefinitionsByIdEntriesByEntryId>;

/** Entries per page of a type's entry list. */
export const METAOBJECT_ENTRY_PAGE_SIZE = 25;

export const metaobjectKeys = {
  all: ["metaobjects"] as const,
  definitions: () => [...metaobjectKeys.all, "definitions"] as const,
  definition: (id: string) => [...metaobjectKeys.all, "definition", id] as const,
  entries: (definitionId: string) => [...metaobjectKeys.all, "entries", definitionId] as const,
  entryPage: (definitionId: string, page: number) => [...metaobjectKeys.entries(definitionId), "page", page] as const,
  entry: (definitionId: string, entryId: string) => [...metaobjectKeys.entries(definitionId), "entry", entryId] as const,
};

/** Every content type, the merchant's and the apps', with its entry count. */
export const metaobjectDefinitionsQueryOptions = () =>
  queryOptions({
    queryKey: metaobjectKeys.definitions(),
    queryFn: async () => (await apiData(getApiV1AdminMetaobjectsDefinitions())).items,
    staleTime: 30_000,
  });

export const metaobjectDefinitionQueryOptions = (id: string) =>
  queryOptions({
    queryKey: metaobjectKeys.definition(id),
    queryFn: async () => (await apiData(getApiV1AdminMetaobjectsDefinitionsById({ path: { id } }))).definition,
    staleTime: 0,
  });

/** One page of a type's entries (with the type itself, so one read draws the page). */
export const metaobjectEntriesQueryOptions = (definitionId: string, page: number) =>
  queryOptions({
    queryKey: metaobjectKeys.entryPage(definitionId, page),
    queryFn: () => apiData(getApiV1AdminMetaobjectsDefinitionsByIdEntries({
      path: { id: definitionId },
      query: { limit: METAOBJECT_ENTRY_PAGE_SIZE, offset: (page - 1) * METAOBJECT_ENTRY_PAGE_SIZE },
    })),
    placeholderData: keepPreviousData,
    staleTime: 0,
  });

export const metaobjectEntryQueryOptions = (definitionId: string, entryId: string) =>
  queryOptions({
    queryKey: metaobjectKeys.entry(definitionId, entryId),
    queryFn: async () => (await apiData(getApiV1AdminMetaobjectsDefinitionsByIdEntriesByEntryId({ path: { id: definitionId, entryId } }))).entry,
    staleTime: 0,
  });

export async function createMetaobjectDefinition(body: CreateMetaobjectDefinitionBody): Promise<MetaobjectDefinition> {
  return (await apiData(postApiV1AdminMetaobjectsDefinitions({ body }))).definition;
}

export async function saveMetaobjectDefinition(id: string, body: UpdateMetaobjectDefinitionBody): Promise<MetaobjectDefinition> {
  return (await apiData(patchApiV1AdminMetaobjectsDefinitionsById({ path: { id }, body }))).definition;
}

export async function createMetaobjectEntry(definitionId: string, body: CreateMetaobjectEntryBody): Promise<MetaobjectEntry> {
  return (await apiData(postApiV1AdminMetaobjectsDefinitionsByIdEntries({ path: { id: definitionId }, body }))).entry;
}

export async function saveMetaobjectEntry(definitionId: string, entryId: string, body: UpdateMetaobjectEntryBody): Promise<MetaobjectEntry> {
  return (await apiData(patchApiV1AdminMetaobjectsDefinitionsByIdEntriesByEntryId({ path: { id: definitionId, entryId }, body }))).entry;
}

export function useDeleteMetaobjectDefinition() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (definition: Pick<MetaobjectDefinition, "id" | "revision">) =>
      apiData(deleteApiV1AdminMetaobjectsDefinitionsById({ path: { id: definition.id }, query: { expectedRevision: definition.revision } })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: metaobjectKeys.all }),
  });
}

export function useDeleteMetaobjectEntry(definitionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (entry: Pick<MetaobjectEntry, "id" | "revision">) =>
      apiData(deleteApiV1AdminMetaobjectsDefinitionsByIdEntriesByEntryId({
        path: { id: definitionId, entryId: entry.id },
        query: { expectedRevision: entry.revision },
      })),
    // The type's entry count changes too.
    onSettled: () => queryClient.invalidateQueries({ queryKey: metaobjectKeys.all }),
  });
}
