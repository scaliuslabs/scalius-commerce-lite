// Common interfaces
export interface ShipmentResult {
  success: boolean;
  message: string;
  shipmentId?: string;
  reconciliationRequired?: boolean;
  data?: {
    externalId?: string;
    trackingId?: string;
    status?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface ShipmentStatus {
  status: string;
  rawStatus: string;
  updatedAt: Date;
  metadata?: Record<string, unknown>;
}

// Pathao specific interfaces
export interface PathaoTokenResponse {
  token_type: string;
  expires_in: number;
  access_token: string;
  refresh_token: string;
}

export interface PathaoOrderResponse {
  message: string;
  type: string;
  code: number;
  data: {
    consignment_id: string;
    merchant_order_id?: string;
    order_status: string;
    delivery_fee: number;
  };
  /** Field-level validation errors returned by Pathao (e.g. { recipient_phone: ["..."] }) */
  errors?: Record<string, string[]>;
}

export interface PathaoStatusResponse {
  message: string;
  type: string;
  code: number;
  data: {
    consignment_id: string;
    merchant_order_id?: string;
    order_status: string;
    order_status_slug: string;
    updated_at: string;
    invoice_id: string | null;
  };
}

export interface PathaoCredentials {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

export interface PathaoConfig {
  storeId: string;
  defaultDeliveryType: number; // 48 for regular, 12 for express
  defaultItemType: number; // 1 for document, 2 for parcel
  defaultItemWeight: number; // In KG, minimum 0.5
}

// Steadfast specific interfaces
export interface SteadfastOrderResponse {
  status: number;
  message: string;
  /** Field-level validation errors returned by Steadfast */
  errors?: Record<string, string[]>;
  consignment: {
    consignment_id: number;
    invoice: string;
    tracking_code: string;
    recipient_name: string;
    recipient_phone: string;
    recipient_address: string;
    cod_amount: number;
    status: string;
    note: string | null;
    created_at: string;
    updated_at: string;
  };
}

export interface SteadfastStatusResponse {
  status: number;
  delivery_status: string;
}

export interface SteadfastCredentials {
  baseUrl: string;
  apiKey: string;
  secretKey: string;
}

export interface SteadfastConfig {
  defaultCodAmount: number;
}

// Provider-agnostic shipment options
export interface ShipmentOptions {
  deliveryType?: number;
  itemType?: number;
  itemWeight?: number;
  codAmount?: number;
  note?: string;
  itemCount?: number;
  itemDescription?: string;
}
