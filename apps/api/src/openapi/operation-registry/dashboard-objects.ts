import { OBJECT_OPERATION_RESPONSE_MAX_BYTES } from "@scalius/shared/plugins/objects";
import type { OperationRegistryEntry } from "./entry";

export function objectOperationResponseLimit(operationId?: string): number {
  return operationId === "objects.list" || operationId === "objects.get" || operationId === "objects.upsert"
    ? OBJECT_OPERATION_RESPONSE_MAX_BYTES : 65_536;
}

export const DASHBOARD_OBJECT_OPERATIONS = {
  "objects.types.list": { stability: "stable", uncurated: true },
  "objects.types.get": { stability: "stable", uncurated: true },
  "objects.types.create": { stability: "stable", replay: true, uncurated: true },
  "objects.types.update": { stability: "stable", revision: "required", uncurated: true },
  "objects.types.delete": { stability: "stable", risk: "destructive", revision: "required", uncurated: true },
  "objects.list": { limits: { response: OBJECT_OPERATION_RESPONSE_MAX_BYTES }, stability: "stable", uncurated: true },
  "objects.get": { limits: { response: OBJECT_OPERATION_RESPONSE_MAX_BYTES }, stability: "stable", uncurated: true },
  "objects.upsert": { limits: { response: OBJECT_OPERATION_RESPONSE_MAX_BYTES }, stability: "stable", revision: "required", uncurated: true },
  "objects.delete": { stability: "stable", risk: "destructive", revision: "required", uncurated: true },
} satisfies Record<string, OperationRegistryEntry>;
