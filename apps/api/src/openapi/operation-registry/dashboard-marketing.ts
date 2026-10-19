// Agent operation registry rows for the dashboard discount, analytics and Meta conversions routes.
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_MARKETING_OPERATIONS = {
  "dashboard.analytics.create": {},
  "dashboard.analytics.delete_permanently": {
    risk: "destructive",
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.analytics.get": {},
  "dashboard.analytics.health": { limits: { response: 16_384 } },
  "dashboard.analytics.list": {},
  "dashboard.analytics.restore": {
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.analytics.set_active": {
    openWorld: true,
    revision: "required",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.analytics.trash": {
    risk: "destructive",
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.analytics.update": { revision: "required" },
  "dashboard.discounts.activate": { stability: "stable", revision: "required" },
  "dashboard.discounts.archive": {
    stability: "stable",
    risk: "destructive",
    revision: "required",
  },
  "dashboard.discounts.create": { stability: "stable", replay: true },
  "dashboard.discounts.get": { stability: "stable" },
  "dashboard.discounts.list": { stability: "stable" },
  "dashboard.discounts.pause": { stability: "stable", revision: "required" },
  "dashboard.discounts.preview": {
    risk: "read",
    revision: "required",
  },
  "dashboard.discounts.update": { stability: "stable", revision: "required" },
  "dashboard.meta_conversions.get": { limits: { response: 16_384 } },
  "dashboard.meta_conversions.logs_cleanup": {
    risk: "destructive",
    limits: { response: 16_384 },
  },
  "dashboard.meta_conversions.logs_clear": {
    risk: "destructive",
    limits: { response: 16_384 },
  },
  "dashboard.meta_conversions.logs_list": {},
  "dashboard.meta_conversions.update": {
    revision: "required",
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
} satisfies Record<string, OperationRegistryEntry>;
