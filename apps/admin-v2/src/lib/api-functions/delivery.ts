import { createServerFn } from "@tanstack/react-start";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.server";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = { [key: string]: JsonValue };

export interface DeliveryProviderRecord {
  id: string;
  name: string;
  type: string;
  credentials: string;
  config: string;
  isActive: boolean;
  createdAt?: string | number;
  updatedAt?: string | number;
}

export interface DeliveryProviderWriteInput {
  id?: string;
  name: string;
  type: string;
  credentials: string | JsonRecord;
  config: string | JsonRecord;
  isActive?: boolean;
}

export interface UpdateDeliveryProviderInput {
  id: string;
  update: {
    name: string;
    type: string;
    credentials?: string | JsonRecord;
    config?: string | JsonRecord;
    isActive?: boolean;
  };
}

export interface DeliveryProviderIdInput {
  id: string;
}

export interface DeliveryTestCredentialsInput {
  type: string;
  credentials: Record<string, string>;
  config: Record<string, string | number>;
  name?: string;
}

export interface DeliveryTestResult {
  success: boolean;
  message?: string;
  [key: string]: JsonValue | undefined;
}

export type DeliveryLocationType = "city" | "zone" | "area";

export type DeliveryLocationsQueryInput = {
  [key: string]: string | number | boolean | undefined;
  type?: DeliveryLocationType | string;
  parentId?: string;
  search?: string;
  page?: number;
  limit?: number;
};

export interface DeliveryLocation {
  id: string;
  name: string;
  type: DeliveryLocationType;
  parentId: string | null;
  externalIds: Record<string, string | number>;
  metadata: JsonRecord;
  isActive: boolean;
  sortOrder: number;
  displayName?: string;
  createdAt?: string | number;
  updatedAt?: string | number;
  deletedAt?: string | number | null;
}

export interface DeliveryLocationsPagination {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface DeliveryLocationsPayload {
  locations: DeliveryLocation[];
  pagination: DeliveryLocationsPagination;
}

export interface DeliveryLocationPayload {
  location: DeliveryLocation;
}

export interface DeliveryLocationWriteInput {
  name: string;
  type: DeliveryLocationType;
  parentId?: string | null;
  externalIds?: Record<string, string | number>;
  metadata?: JsonRecord;
  isActive?: boolean;
  sortOrder?: number;
}

export interface UpdateDeliveryLocationInput {
  id: string;
  update: Partial<DeliveryLocationWriteInput>;
}

export interface DeliveryLocationIdInput {
  id: string;
}

export interface BulkDeleteDeliveryLocationsInput {
  ids: string[];
}

export interface MessagePayload {
  message?: string;
}

export interface PathaoImportProgress {
  status: "importing" | "complete" | "error";
  phase: "cities" | "zones" | "areas" | "done";
  progress: { current: number; total: number; label: string };
  stats: {
    citiesCreated: number;
    citiesUpdated: number;
    zonesCreated: number;
    zonesUpdated: number;
    areasCreated: number;
    areasUpdated: number;
  };
  error?: string;
}

function toQueryParams(data: DeliveryLocationsQueryInput): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== "") params[key] = String(value);
  }
  return params;
}

export const getDeliveryProviders = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<DeliveryProviderRecord[]>("/settings/delivery-providers");
  },
);

export const createDeliveryProvider = createServerFn({ method: "POST" })
  .validator((data: DeliveryProviderWriteInput) => data)
  .handler(async ({ data }) => {
    return apiPost<DeliveryProviderRecord>("/settings/delivery-providers", data);
  });

export const updateDeliveryProvider = createServerFn({ method: "POST" })
  .validator((data: UpdateDeliveryProviderInput) => data)
  .handler(async ({ data }) => {
    return apiPut<DeliveryProviderRecord>("/settings/delivery-providers", {
      id: data.id,
      ...data.update,
    });
  });

export const deleteDeliveryProvider = createServerFn({ method: "POST" })
  .validator((data: DeliveryProviderIdInput) => data)
  .handler(async ({ data }) => {
    return apiDelete<Record<string, never>>(
      `/settings/delivery-providers/${data.id}`,
    );
  });

export const testDeliveryProvider = createServerFn({ method: "POST" })
  .validator((data: DeliveryProviderIdInput) => data)
  .handler(async ({ data }) => {
    return apiPost<DeliveryTestResult>(
      `/settings/delivery-providers/${data.id}`,
    );
  });

export const testDeliveryCredentials = createServerFn({ method: "POST" })
  .validator((data: DeliveryTestCredentialsInput) => data)
  .handler(async ({ data }) => {
    return apiPost<DeliveryTestResult>(
      "/settings/delivery-providers/create-test",
      data,
    );
  });

export const saveDeliveryProvider = createServerFn({ method: "POST" })
  .validator((data: { provider: DeliveryProviderWriteInput }) => data)
  .handler(async ({ data }) => {
    const provider = data.provider;
    if (provider.id) {
      return apiPut<DeliveryProviderRecord>(
        "/settings/delivery-providers",
        provider,
      );
    }
    return apiPost<DeliveryProviderRecord>(
      "/settings/delivery-providers",
      provider,
    );
  });

export const getDeliveryLocations = createServerFn({ method: "GET" })
  .validator((data: DeliveryLocationsQueryInput) => data)
  .handler(async ({ data }) => {
    return apiGet<DeliveryLocationsPayload>(
      "/settings/delivery-locations",
      toQueryParams(data),
    );
  });

export const getAllDeliveryLocations = createServerFn({ method: "GET" })
  .validator((data: { type?: DeliveryLocationType | string }) => data)
  .handler(async ({ data }) => {
    const params: DeliveryLocationsQueryInput = { limit: 500, page: 1 };
    if (data.type) params.type = data.type;

    const firstPage = await apiGet<DeliveryLocationsPayload>(
      "/settings/delivery-locations",
      toQueryParams(params),
    );

    const locations = [...firstPage.locations];
    const totalPages = firstPage.pagination.totalPages;

    for (let page = 2; page <= totalPages; page += 1) {
      const nextPage = await apiGet<DeliveryLocationsPayload>(
        "/settings/delivery-locations",
        toQueryParams({ ...params, page }),
      );
      locations.push(...nextPage.locations);
    }

    return {
      locations,
      pagination: firstPage.pagination,
    };
  });

export const createDeliveryLocation = createServerFn({ method: "POST" })
  .validator((data: DeliveryLocationWriteInput) => data)
  .handler(async ({ data }) => {
    return apiPost<DeliveryLocationPayload>("/settings/delivery-locations", data);
  });

export const updateDeliveryLocation = createServerFn({ method: "POST" })
  .validator((data: UpdateDeliveryLocationInput) => data)
  .handler(async ({ data }) => {
    return apiPut<DeliveryLocation>(
      `/settings/delivery-locations/${data.id}`,
      data.update,
    );
  });

export const deleteDeliveryLocation = createServerFn({ method: "POST" })
  .validator((data: DeliveryLocationIdInput) => data)
  .handler(async ({ data }) => {
    return apiDelete<Record<string, never>>(
      `/settings/delivery-locations/${data.id}`,
    );
  });

export const bulkDeleteDeliveryLocations = createServerFn({ method: "POST" })
  .validator((data: BulkDeleteDeliveryLocationsInput) => data)
  .handler(async ({ data }) => {
    return apiDelete<MessagePayload>("/settings/delivery-locations", data);
  });

export const cleanAllDeliveryLocations = createServerFn({
  method: "POST",
}).handler(async () => {
  return apiDelete<MessagePayload>("/settings/delivery-locations/all", {
    confirmDeleteAll: true,
  });
});

export const importPathaoLocations = createServerFn({ method: "POST" })
  .validator((data: JsonRecord) => data)
  .handler(async ({ data }) => {
    return apiPost<PathaoImportProgress>(
      "/settings/delivery-locations/import-pathao",
      data,
    );
  });

export const getImportPathaoStatus = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<PathaoImportProgress>(
      "/settings/delivery-locations/import-pathao/status",
    );
  },
);

export const resetImportPathao = createServerFn({ method: "POST" }).handler(
  async () => {
    return apiDelete<MessagePayload>(
      "/settings/delivery-locations/import-pathao",
    );
  },
);
