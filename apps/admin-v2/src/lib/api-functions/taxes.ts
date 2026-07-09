import { createServerFn } from "@tanstack/react-start";

import { apiDelete, apiGet, apiPost, apiPut } from "../api.server";

export type TaxJurisdictionType = "all" | "city" | "zone" | "area";
export type TaxClassificationKind = "product" | "variant";

export interface TaxSettingsRecord {
  id: "default";
  enabled: boolean;
  pricesIncludeTax: boolean;
  taxShipping: boolean;
  defaultTaxClassId: string | null;
  shippingTaxClassId: string | null;
  displayLabel: string;
  version: number;
  createdAt: string | number | null;
  updatedAt: string | number | null;
}

export interface TaxClassRecord {
  id: string;
  name: string;
  description: string | null;
  isExempt: boolean;
  version: number;
  createdAt: string | number | null;
  updatedAt: string | number | null;
  deletedAt: string | number | null;
}

export interface TaxRateRecord {
  id: string;
  taxClassId: string;
  name: string;
  rateBps: number;
  jurisdictionType: TaxJurisdictionType;
  jurisdictionId: string | null;
  jurisdictionLabel: string | null;
  priority: number;
  isCompound: boolean;
  isActive: boolean;
  version: number;
  createdAt: string | number | null;
  updatedAt: string | number | null;
  deletedAt: string | number | null;
}

export interface TaxJurisdictionOption {
  id: string;
  name: string;
  type: Exclude<TaxJurisdictionType, "all">;
  parentId: string | null;
}

export interface TaxConfigurationPayload {
  settings: TaxSettingsRecord;
  classes: TaxClassRecord[];
  rates: TaxRateRecord[];
  jurisdictions: TaxJurisdictionOption[];
}

export interface UpdateTaxSettingsInput {
  expectedVersion: number;
  enabled: boolean;
  pricesIncludeTax: boolean;
  taxShipping: boolean;
  defaultTaxClassId: string | null;
  shippingTaxClassId: string | null;
  displayLabel: string;
}

export interface TaxClassWriteInput {
  name: string;
  description?: string | null;
  isExempt?: boolean;
}

export interface TaxRateWriteInput {
  taxClassId: string;
  name: string;
  rateBps: number;
  jurisdictionType: TaxJurisdictionType;
  jurisdictionId?: string | null;
  jurisdictionLabel?: string | null;
  priority?: number;
  isCompound?: boolean;
  isActive?: boolean;
}

export interface TaxClassificationItem {
  kind: TaxClassificationKind;
  id: string;
  productId: string;
  productName: string;
  label: string;
  sku: string | null;
  taxClassId: string | null;
  taxClassName: string | null;
  version: number;
}

export interface TaxClassificationPayload {
  items: TaxClassificationItem[];
  total: number;
}

export interface TaxPreviewInput {
  amount: number;
  quantity: number;
  taxClassId?: string | null;
  shippingAmount: number;
  discountAmount: number;
  city: string;
  zone: string;
  area?: string | null;
}

export interface TaxPreviewComponent {
  name: string;
  rateBps: number;
  amountMinor: number;
  priority?: number;
  compound?: boolean;
}

export interface TaxPreviewPayload {
  displayLabel: string;
  pricesIncludeTax: boolean;
  currencyCode: string;
  decimalPlaces: number;
  taxAmount: number;
  taxMinor: number;
  totalAmount: number;
  totalMinor: number;
  components: TaxPreviewComponent[];
}

function encodedId(value: string): string {
  return encodeURIComponent(value);
}

export const getTaxConfiguration = createServerFn({ method: "GET" }).handler(
  async () => apiGet<TaxConfigurationPayload>("/taxes"),
);

export const saveTaxSettings = createServerFn({ method: "POST" })
  .validator((data: UpdateTaxSettingsInput) => data)
  .handler(async ({ data }) =>
    apiPut<{ settings: TaxSettingsRecord }>("/taxes/settings", data),
  );

export const createTaxClass = createServerFn({ method: "POST" })
  .validator((data: TaxClassWriteInput) => data)
  .handler(async ({ data }) =>
    apiPost<{ taxClass: TaxClassRecord }>("/taxes/classes", data),
  );

export const updateTaxClass = createServerFn({ method: "POST" })
  .validator((data: { id: string; expectedVersion: number; update: TaxClassWriteInput }) => data)
  .handler(async ({ data }) =>
    apiPut<{ taxClass: TaxClassRecord }>(`/taxes/classes/${encodedId(data.id)}`, {
      ...data.update,
      expectedVersion: data.expectedVersion,
    }),
  );

export const deleteTaxClass = createServerFn({ method: "POST" })
  .validator((data: { id: string; expectedVersion: number }) => data)
  .handler(async ({ data }) =>
    apiDelete<{ taxClass: TaxClassRecord }>(
      `/taxes/classes/${encodedId(data.id)}?expectedVersion=${data.expectedVersion}`,
    ),
  );

export const createTaxRate = createServerFn({ method: "POST" })
  .validator((data: TaxRateWriteInput) => data)
  .handler(async ({ data }) =>
    apiPost<{ taxRate: TaxRateRecord }>("/taxes/rates", data),
  );

export const updateTaxRate = createServerFn({ method: "POST" })
  .validator((data: { id: string; expectedVersion: number; update: Partial<TaxRateWriteInput> }) => data)
  .handler(async ({ data }) =>
    apiPut<{ taxRate: TaxRateRecord }>(`/taxes/rates/${encodedId(data.id)}`, {
      ...data.update,
      expectedVersion: data.expectedVersion,
    }),
  );

export const deleteTaxRate = createServerFn({ method: "POST" })
  .validator((data: { id: string; expectedVersion: number }) => data)
  .handler(async ({ data }) =>
    apiDelete<{ taxRate: TaxRateRecord }>(
      `/taxes/rates/${encodedId(data.id)}?expectedVersion=${data.expectedVersion}`,
    ),
  );

export const getTaxClassifications = createServerFn({ method: "GET" })
  .validator((data: {
    kind: TaxClassificationKind;
    page: number;
    limit: number;
    search?: string;
  }) => data)
  .handler(async ({ data }) =>
    apiGet<TaxClassificationPayload>("/taxes/classifications", {
      kind: data.kind,
      page: String(data.page),
      limit: String(data.limit),
      ...(data.search ? { search: data.search } : {}),
    }),
  );

export const updateTaxClassification = createServerFn({ method: "POST" })
  .validator((data: {
    kind: TaxClassificationKind;
    id: string;
    taxClassId: string | null;
    expectedVersion: number;
  }) => data)
  .handler(async ({ data }) =>
    apiPut<{ classification: Pick<TaxClassificationItem, "kind" | "id" | "taxClassId" | "version"> }>(
      `/taxes/classifications/${data.kind}/${encodedId(data.id)}`,
      { taxClassId: data.taxClassId, expectedVersion: data.expectedVersion },
    ),
  );

export const previewTaxConfiguration = createServerFn({ method: "POST" })
  .validator((data: TaxPreviewInput) => data)
  .handler(async ({ data }) =>
    apiPost<TaxPreviewPayload>("/taxes/preview", data),
  );
