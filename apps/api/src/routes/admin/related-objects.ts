import type { Context } from "hono";
import { parseRelatedObjects, relatedObjectsJson } from "@scalius/core/modules/objects";

/** Resource permissions alone never reveal app records; apps use their namespace-scoped Objects API. */
export function relatedObjectsProjection(c: Context, resource: "product" | "order" | "customer", id: string) {
  if (c.get("pluginPrincipal")) return undefined;
  return (c.get("adminPermissions") as ReadonlySet<string> | undefined)?.has("objects.view")
    ? relatedObjectsJson(resource, id)
    : undefined;
}

export function withRelatedObjects<T extends { relatedObjectsJson: string | null }>(value: T) {
  const { relatedObjectsJson: records, ...resource } = value;
  return { ...resource, relatedObjects: parseRelatedObjects(records) };
}
