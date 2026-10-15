import { AppError } from "@scalius/core/errors";
import { checkoutAttributesSchema, type CheckoutAttribute } from "@scalius/shared/plugins/buyer-ui";
import type { CheckoutAppFunctions } from "./app-functions";

/** Unknown keys disappear before any app sees them or an order stores them. */
export function validateCheckoutAttributes(
  apps: CheckoutAppFunctions | undefined,
  input: Record<string, string> | undefined,
  requireAll = false,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const declaration of apps?.attributes ?? []) {
    const { appId, fields } = declaration;
    for (const field of fields) {
      const key = `${appId}.${field.key}`;
      const value = input?.[key];
      if (value === undefined || value === "") {
        if (requireAll && field.required) refuse(key);
        continue;
      }
      if (!fits(field, value)) refuse(key);
      output[key] = value;
    }
  }
  if (!checkoutAttributesSchema.safeParse(output).success) refuse();
  return output;
}
function refuse(key?: string): never {
  throw new AppError(400, "attribute_invalid", "Review the additional checkout information.", key ? { attribute: key } : undefined);
}
function fits(field: CheckoutAttribute, value: string): boolean {
  if (typeof value !== "string" || value.length > (field.maxLength ?? 500)) return false;
  if (field.type === "boolean") return value === "true" || value === "false";
  if (field.type === "choice") return Boolean(field.choices?.some((choice) => choice.value === value));
  if (field.type === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (field.type === "number") {
    if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return false;
    const number = Number(value);
    return Number.isFinite(number) && (field.min === undefined || number >= field.min) && (field.max === undefined || number <= field.max);
  }
  return true;
}
