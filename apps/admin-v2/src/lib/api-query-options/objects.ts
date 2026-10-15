import { keepPreviousData, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ObjectField, ObjectTypeView, ObjectRecordView } from "@scalius/shared/plugins/objects";
import { apiClient, apiData } from "../api";

export type ObjectType = ObjectTypeView;
export type ObjectRecord = ObjectRecordView;
export type { ObjectField };
export interface CreateObjectTypeBody {
  type: string;
  name: string;
  description?: string;
  fields: ObjectField[];
  display?: string;
  storefront?: boolean;
  admin?: "none" | "read" | "edit";
  handle?: boolean;
  indexes?: ObjectType["indexes"];
  unique?: ObjectType["unique"];
  events?: boolean;
}
export type UpdateObjectTypeBody = Omit<CreateObjectTypeBody, "type"> & { expectedRevision: number };
export interface CreateObjectRecordBody {
  data: Record<string, unknown>;
  expectedRevision: null;
  status?: "active" | "draft" | "published";
  handle?: string;
}
export type UpdateObjectRecordBody = Omit<CreateObjectRecordBody, "expectedRevision"> & { expectedRevision: number };

export const OBJECT_RECORD_PAGE_SIZE = 25;
const base = "/api/v1/admin/objects";
const typePath = (type: string) => `${base}/types/${encodeURIComponent(type)}`;
const recordsPath = (type: string) => `${base}/${encodeURIComponent(type)}`;
const recordPath = (type: string, id: string) => `${recordsPath(type)}/${encodeURIComponent(id)}`;
type Envelope<T> = { 200: { success: boolean; data: T } };

export const objectKeys = {
  all: ["objects"] as const,
  definitions: () => [...objectKeys.all, "types"] as const,
  definition: (type: string) => [...objectKeys.all, "type", type] as const,
  entries: (type: string) => [...objectKeys.all, "records", type] as const,
  entryPage: (type: string, cursor: string | undefined) => [...objectKeys.entries(type), "page", cursor ?? ""] as const,
  entry: (type: string, id: string) => [...objectKeys.entries(type), "record", id] as const,
};

export const objectTypesQueryOptions = () => queryOptions({
  queryKey: objectKeys.definitions(),
  queryFn: async () => (await apiData(apiClient.get<Envelope<{ items: ObjectType[] }>>({ url: `${base}/types` }))).items,
  staleTime: 30_000,
});

export const objectTypeQueryOptions = (type: string) => queryOptions({
  queryKey: objectKeys.definition(type),
  queryFn: async () => (await apiData(apiClient.get<Envelope<{ type: ObjectType }>>({ url: typePath(type) }))).type,
  staleTime: 0,
});

export const objectRecordsQueryOptions = (type: string, cursor?: string, where: Record<string, string> = {}) => queryOptions({
  queryKey: [...objectKeys.entryPage(type, cursor), where],
  queryFn: () => apiData(apiClient.get<Envelope<{ type: ObjectType; records: ObjectRecord[]; total: number; nextCursor: string | null }>>({
    url: recordsPath(type), query: { limit: OBJECT_RECORD_PAGE_SIZE, ...(cursor ? { cursor } : {}), ...(Object.keys(where).length ? { where: JSON.stringify(where) } : {}) },
  })),
  placeholderData: keepPreviousData,
  staleTime: 0,
});

export const objectRecordQueryOptions = (type: string, id: string) => queryOptions({
  queryKey: objectKeys.entry(type, id),
  queryFn: async () => (await apiData(apiClient.get<Envelope<{ record: ObjectRecord }>>({ url: recordPath(type, id) }))).record,
  staleTime: 0,
});

export async function createObjectType(body: CreateObjectTypeBody): Promise<ObjectType> {
  return (await apiData(apiClient.post<Envelope<{ type: ObjectType }>>({ url: `${base}/types`, body }))).type;
}
export async function saveObjectType(type: string, body: UpdateObjectTypeBody): Promise<ObjectType> {
  return (await apiData(apiClient.patch<Envelope<{ type: ObjectType }>>({ url: typePath(type), body }))).type;
}
export async function createObjectRecord(type: string, body: CreateObjectRecordBody, id: string): Promise<ObjectRecord> {
  return (await apiData(apiClient.put<Envelope<{ record: ObjectRecord }>>({ url: recordPath(type, id), body }))).record;
}
export async function saveObjectRecord(type: string, id: string, body: UpdateObjectRecordBody): Promise<ObjectRecord> {
  return (await apiData(apiClient.put<Envelope<{ record: ObjectRecord }>>({ url: recordPath(type, id), body }))).record;
}
export function useDeleteObjectType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (type: Pick<ObjectType, "handle" | "revision">) => apiData(apiClient.delete<Envelope<{ deleted: boolean }>>({
      url: typePath(type.handle), query: { expectedRevision: type.revision },
    })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: objectKeys.all }),
  });
}
export function useDeleteObjectRecord(type: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (record: Pick<ObjectRecord, "id" | "revision">) => apiData(apiClient.delete<Envelope<{ deleted: boolean }>>({
      url: recordPath(type, record.id), query: { expectedRevision: record.revision },
    })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: objectKeys.all }),
  });
}
