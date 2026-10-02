// Custom data (COMMERCE-HOOKS H4): definitions for Settings › Custom data and
// each owner's values for the Custom data card. Values are read and written
// through one route pair per owner type, so each sits under its owner's
// permissions (products, customers, orders, …).
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  deleteApiV1AdminCustomFieldDefinitionsById,
  getApiV1AdminCustomFieldDefinitions,
  getApiV1AdminCustomFieldsBrandByOwnerId,
  getApiV1AdminCustomFieldsCategoryByOwnerId,
  getApiV1AdminCustomFieldsCollectionByOwnerId,
  getApiV1AdminCustomFieldsCustomerByOwnerId,
  getApiV1AdminCustomFieldsOrderByOwnerId,
  getApiV1AdminCustomFieldsPageByOwnerId,
  getApiV1AdminCustomFieldsProductByOwnerId,
  getApiV1AdminCustomFieldsVariantByOwnerId,
  patchApiV1AdminCustomFieldDefinitionsById,
  postApiV1AdminCustomFieldDefinitions,
  postApiV1AdminCustomFieldDefinitionsReorder,
  putApiV1AdminCustomFieldsBrandByOwnerId,
  putApiV1AdminCustomFieldsCategoryByOwnerId,
  putApiV1AdminCustomFieldsCollectionByOwnerId,
  putApiV1AdminCustomFieldsCustomerByOwnerId,
  putApiV1AdminCustomFieldsOrderByOwnerId,
  putApiV1AdminCustomFieldsPageByOwnerId,
  putApiV1AdminCustomFieldsProductByOwnerId,
  putApiV1AdminCustomFieldsVariantByOwnerId,
} from "@scalius/api-client/sdk";
import type {
  CustomFieldOwnerType,
  CustomFieldType,
  CustomFieldWireValidations,
  CustomFieldWireValue,
} from "@scalius/shared/custom-fields";
import { apiData } from "../api";

/** A definition as the admin API returns it (`AdminCustomFieldDefinition`). */
export interface CustomFieldDefinition {
  id: string;
  ownerType: CustomFieldOwnerType;
  namespace: string;
  key: string;
  name: string;
  description: string | null;
  type: CustomFieldType;
  validations: CustomFieldWireValidations;
  storefrontVisible: boolean;
  position: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomFieldDefinitionListItem extends CustomFieldDefinition {
  valueCount: number;
}

export interface CustomFieldEntry {
  definition: CustomFieldDefinition;
  value: CustomFieldWireValue | null;
  updatedAt: string | null;
}

export interface CustomFieldOwnerValues {
  ownerType: CustomFieldOwnerType;
  ownerId: string;
  fields: CustomFieldEntry[];
}

export interface CreateCustomFieldDefinitionBody {
  ownerType: CustomFieldOwnerType;
  name: string;
  key?: string;
  description?: string | null;
  type: CustomFieldType;
  validations?: CustomFieldWireValidations | null;
  storefrontVisible?: boolean;
}

export interface UpdateCustomFieldDefinitionBody {
  expectedRevision: number;
  name?: string;
  description?: string | null;
  validations?: CustomFieldWireValidations | null;
  storefrontVisible?: boolean;
}

type OwnerOptions = { path: { ownerId: string } };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SdkCall = (options: any) => Promise<{ data?: unknown; error?: unknown; response?: Response }>;

/** The owner type's route pair, looked up per call (never at module load). */
function ownerCalls(ownerType: CustomFieldOwnerType): { get: SdkCall; put: SdkCall } {
  switch (ownerType) {
    case "product": return { get: getApiV1AdminCustomFieldsProductByOwnerId, put: putApiV1AdminCustomFieldsProductByOwnerId };
    case "variant": return { get: getApiV1AdminCustomFieldsVariantByOwnerId, put: putApiV1AdminCustomFieldsVariantByOwnerId };
    case "customer": return { get: getApiV1AdminCustomFieldsCustomerByOwnerId, put: putApiV1AdminCustomFieldsCustomerByOwnerId };
    case "order": return { get: getApiV1AdminCustomFieldsOrderByOwnerId, put: putApiV1AdminCustomFieldsOrderByOwnerId };
    case "category": return { get: getApiV1AdminCustomFieldsCategoryByOwnerId, put: putApiV1AdminCustomFieldsCategoryByOwnerId };
    case "collection": return { get: getApiV1AdminCustomFieldsCollectionByOwnerId, put: putApiV1AdminCustomFieldsCollectionByOwnerId };
    case "brand": return { get: getApiV1AdminCustomFieldsBrandByOwnerId, put: putApiV1AdminCustomFieldsBrandByOwnerId };
    case "page": return { get: getApiV1AdminCustomFieldsPageByOwnerId, put: putApiV1AdminCustomFieldsPageByOwnerId };
  }
}

export const customFieldKeys = {
  all: ["custom-fields"] as const,
  definitions: (ownerType: CustomFieldOwnerType | "all") => [...customFieldKeys.all, "definitions", ownerType] as const,
  values: (ownerType: CustomFieldOwnerType, ownerId: string) => [...customFieldKeys.all, "values", ownerType, ownerId] as const,
};

/** Every definition (Settings › Custom data groups them by owner type). */
export const customFieldDefinitionsQueryOptions = () =>
  queryOptions({
    queryKey: customFieldKeys.definitions("all"),
    queryFn: async () =>
      (await apiData(getApiV1AdminCustomFieldDefinitions({}))) as unknown as { definitions: CustomFieldDefinitionListItem[] },
    staleTime: 30_000,
  });

/** Every field of an owner type with this owner's values. */
export const customFieldValuesQueryOptions = (ownerType: CustomFieldOwnerType, ownerId: string) =>
  queryOptions({
    queryKey: customFieldKeys.values(ownerType, ownerId),
    queryFn: async () =>
      (await apiData(ownerCalls(ownerType).get({ path: { ownerId } } satisfies OwnerOptions))) as unknown as CustomFieldOwnerValues,
    staleTime: 0,
  });

/** Sets and clears values in one all-or-nothing request; returns the owner's fields as saved. */
export async function saveCustomFieldValues(
  ownerType: CustomFieldOwnerType,
  ownerId: string,
  values: Array<{ definitionId: string; value: unknown }>,
): Promise<CustomFieldOwnerValues> {
  return (await apiData(ownerCalls(ownerType).put({ path: { ownerId }, body: { values } }))) as unknown as CustomFieldOwnerValues;
}

function useRefreshDefinitions() {
  const queryClient = useQueryClient();
  // Definitions shape every card too: refresh both.
  return () => queryClient.invalidateQueries({ queryKey: customFieldKeys.all });
}

export function useSaveCustomFieldDefinition() {
  const refresh = useRefreshDefinitions();
  return useMutation({
    mutationFn: async (input: { id: null; body: CreateCustomFieldDefinitionBody } | { id: string; body: UpdateCustomFieldDefinitionBody }) =>
      (await (input.id === null
        ? apiData(postApiV1AdminCustomFieldDefinitions({ body: input.body as never }))
        : apiData(patchApiV1AdminCustomFieldDefinitionsById({ path: { id: input.id }, body: input.body as never })))) as unknown as { definition: CustomFieldDefinition },
    onSettled: refresh,
  });
}

export function useDeleteCustomFieldDefinition() {
  const refresh = useRefreshDefinitions();
  return useMutation({
    mutationFn: (input: { id: string; expectedRevision: number }) =>
      apiData(deleteApiV1AdminCustomFieldDefinitionsById({ path: { id: input.id }, query: { expectedRevision: input.expectedRevision } })),
    onSettled: refresh,
  });
}

export function useReorderCustomFieldDefinitions() {
  const refresh = useRefreshDefinitions();
  return useMutation({
    mutationFn: (input: { ownerType: CustomFieldOwnerType; definitions: Array<{ id: string; expectedRevision: number }> }) =>
      apiData(postApiV1AdminCustomFieldDefinitionsReorder({ body: input })),
    onSettled: refresh,
  });
}
