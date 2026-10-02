// Agent operation registry rows for store migration (import batches and
// paged CSV exports). Batches are bounded (50 products, 20 image jobs, 100
// customers or counts, 1 MiB) and idempotent: re-sending items is a no-op.
import type { OperationRegistryEntry } from "./entry";

const IMPORT_REQUEST_BYTES = 1024 * 1024;

const csvPage = {
  batch: "forbidden",
  artifact: {
    mediaTypes: ["text/csv"],
    disposition: "attachment",
    filenamePolicy: "content-disposition",
    maxArtifactBytes: 16 * 1024 * 1024,
    delivery: "authenticated-handle",
  },
} satisfies OperationRegistryEntry;

export const DASHBOARD_STORE_TRANSFER_OPERATIONS = {
  "dashboard.import.products_batch": {
    idempotency: "supported",
    revision: "optional",
    batch: "sequential",
    limits: { request: IMPORT_REQUEST_BYTES },
  },
  "dashboard.import.product_images_batch": {
    openWorld: true,
    idempotency: "supported",
    batch: "sequential",
    limits: { request: IMPORT_REQUEST_BYTES },
  },
  "dashboard.import.customers_batch": {
    idempotency: "supported",
    batch: "sequential",
    limits: { request: IMPORT_REQUEST_BYTES },
  },
  "dashboard.import.inventory_batch": {
    idempotency: "supported",
    revision: "optional",
    batch: "sequential",
    limits: { request: IMPORT_REQUEST_BYTES },
  },
  "dashboard.export.products": csvPage,
  "dashboard.export.inventory": csvPage,
} satisfies Record<string, OperationRegistryEntry>;
