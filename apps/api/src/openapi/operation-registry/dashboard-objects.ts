import { OBJECT_OPERATION_RESPONSE_MAX_BYTES } from "@scalius/shared/plugins/objects";
import type { OperationRegistryEntry } from "./entry";

export function objectOperationResponseLimit(operationId?: string): number {
  return operationId === "objects.list" || operationId === "objects.get" || operationId === "objects.upsert"
    ? OBJECT_OPERATION_RESPONSE_MAX_BYTES : 65_536;
}

export const DASHBOARD_OBJECT_OPERATIONS = {
  "objects.types.list": { uncurated: true },
  "objects.types.get": { uncurated: true },
  "objects.types.create": { uncurated: true },
  "objects.types.update": { revision: "required", uncurated: true },
  "objects.types.delete": { risk: "destructive", revision: "required", uncurated: true },
  "objects.list": { limits: { response: OBJECT_OPERATION_RESPONSE_MAX_BYTES }, uncurated: true },
  "objects.get": { limits: { response: OBJECT_OPERATION_RESPONSE_MAX_BYTES }, uncurated: true },
  "objects.upsert": { limits: { response: OBJECT_OPERATION_RESPONSE_MAX_BYTES }, revision: "required", uncurated: true },
  "objects.delete": { risk: "destructive", revision: "required", uncurated: true },
} satisfies Record<string, OperationRegistryEntry>;
