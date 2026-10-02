// Agent operation registry rows for webhook endpoints and the store event log
// (COMMERCE-HOOKS H3). Endpoints receive order, customer and product data,
// so every write is a security write that runs alone, and the two calls that
// return a signing secret are reviewed one-time-secret operations.
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_WEBHOOK_OPERATIONS = {
  "dashboard.webhooks.list": { limits: { response: 65_536 } },
  "dashboard.webhooks.get": { limits: { response: 16_384 } },
  "dashboard.webhooks.create": {
    risk: "security",
    batch: "forbidden",
    limits: { request: 16_384, response: 16_384 },
    sensitive: true,
    oneTimeSecret: true,
  },
  "dashboard.webhooks.update": {
    risk: "security",
    batch: "forbidden",
    revision: "required",
    limits: { request: 16_384, response: 16_384 },
  },
  "dashboard.webhooks.delete": {
    risk: "destructive",
    batch: "forbidden",
    limits: { request: 16_384, response: 8_192 },
  },
  "dashboard.webhooks.rotate_secret": {
    risk: "security",
    batch: "forbidden",
    limits: { request: 16_384, response: 16_384 },
    sensitive: true,
    oneTimeSecret: true,
  },
  "dashboard.webhooks.test": {
    risk: "security",
    openWorld: true,
    batch: "forbidden",
    limits: { request: 16_384, response: 16_384 },
  },
  "dashboard.webhooks.deliveries_list": { limits: { response: 65_536 } },
  "dashboard.webhooks.delivery_retry": {
    openWorld: true,
    batch: "forbidden",
    limits: { request: 16_384, response: 16_384 },
  },
  "dashboard.events.list": { limits: { response: 65_536 } },
} as const satisfies Record<string, OperationRegistryEntry>;
