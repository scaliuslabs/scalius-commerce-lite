/**
 * The buyer's answers to the store apps' checkout questions, checked in the
 * browser exactly as `checkoutAttributesSchema` (`@scalius/shared/plugins/
 * buyer-ui`) checks them, without loading zod on every page that reads them
 * (the cart drawer, sign-in, checkout state). The API checks them again;
 * checkout-attributes.test.ts holds this guard to the schema.
 */

/** `CHECKOUT_ATTRIBUTES_MAX_BYTES` and the schema's key and value lengths. */
export const CHECKOUT_ATTRIBUTE_KEY_MAX_LENGTH = 160;
export const CHECKOUT_ATTRIBUTE_VALUE_MAX_LENGTH = 500;
export const CHECKOUT_ATTRIBUTES_MAX_BYTES = 8 * 1024;

/** zod's plain-object test: an object literal or a JSON object, not an array, class instance or null. */
function isPlainObject(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const ctor = (value as { constructor?: unknown }).constructor;
  if (ctor === undefined || typeof ctor !== "function") return true;
  const prototype: unknown = ctor.prototype;
  if (typeof prototype !== "object" || prototype === null || Array.isArray(prototype)) return false;
  return Object.prototype.hasOwnProperty.call(prototype, "isPrototypeOf");
}

/**
 * The answers as a fresh string record, or null when `value` is not one: an
 * object whose every own key is a string of at most 160 characters and every
 * value a string of at most 500, 8 KiB at most as JSON. A `__proto__` key is
 * dropped, as the schema drops it.
 */
export function parseCheckoutAttributeValues(value: unknown): Record<string, string> | null {
  if (!isPlainObject(value)) return null;
  const answers: Record<string, string> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (key === "__proto__" || !Object.prototype.propertyIsEnumerable.call(value, key)) continue;
    if (typeof key !== "string" || key.length > CHECKOUT_ATTRIBUTE_KEY_MAX_LENGTH) return null;
    const answer = value[key];
    if (typeof answer !== "string" || answer.length > CHECKOUT_ATTRIBUTE_VALUE_MAX_LENGTH) return null;
    answers[key] = answer;
  }
  return new TextEncoder().encode(JSON.stringify(answers)).byteLength <= CHECKOUT_ATTRIBUTES_MAX_BYTES
    ? answers
    : null;
}
