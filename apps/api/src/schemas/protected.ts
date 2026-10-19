// Protected customer data in route schemas (COMMERCE-HOOKS H5): a buyer
// contact field is marked once here with its category, and an app without
// that category's scope reads it as null (plugins/protected-response.ts).
// Staff and the merchant's own agents see it as declared.
import type { z } from "@hono/zod-openapi";
import { PROTECTED_FIELD_KEYWORD, type ProtectedCustomerData } from "@scalius/shared/plugins/protected-data";

type Category = ProtectedCustomerData | readonly ProtectedCustomerData[];

/** Marks a field `x-scalius-protected: <category>` (a list: revealed only with all of them). */
export function protectedField<T extends z.ZodType>(category: Category, schema: T): T {
  return (schema as unknown as { openapi(metadata: Record<string, unknown>): T }).openapi({
    [PROTECTED_FIELD_KEYWORD]: typeof category === "string" ? category : [...category],
  });
}

/** Marks every listed key of a shape with its category (spread into `z.object`). */
export function protectedShape<S extends Record<string, z.ZodType>>(shape: S, categories: Partial<Record<keyof S, Category>>): S {
  const marked: Record<string, z.ZodType> = { ...shape };
  for (const [key, category] of Object.entries(categories) as Array<[keyof S & string, Category | undefined]>) {
    if (category && marked[key]) marked[key] = protectedField(category, marked[key]!);
  }
  return marked as S;
}
