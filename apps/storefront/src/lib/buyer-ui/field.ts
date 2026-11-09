import type { CheckoutAttribute } from "@scalius/shared/plugins/buyer-ui";
import { offeredChoices } from "@scalius/shared/plugins/checkout-attribute-values";

/**
 * One host-owned field description for server forms and private buyer UI.
 * `computed` are the choices an extension offered this render (a select of
 * them): over a `text` attribute (the answer stays text the app checks), a
 * `date` (each day written in `language`) or a `choice` (some of its values),
 * as `offeredChoices` words them.
 */
export function buyerFieldModel(attribute: CheckoutAttribute, name = attribute.key, value = "", computed?: ReadonlyArray<{ value: string; label: string }>, language = "en") {
  const offered = offeredChoices(attribute, computed, language);
  const tag = attribute.type === "multiline" ? "textarea" : offered || attribute.type === "choice" || (attribute.type === "boolean" && attribute.required) ? "select" : "input";
  const inputType: "checkbox" | "number" | "date" | "text" = attribute.type === "boolean" ? "checkbox" : attribute.type === "number" || attribute.type === "date" ? attribute.type : "text";
  return {
    tag,
    attributes: {
      name,
      required: attribute.required === true,
      ...(tag === "input" ? { type: inputType } : {}),
      ...(tag !== "select" && (attribute.type === "text" || attribute.type === "multiline") ? { maxlength: attribute.maxLength ?? 500 } : {}),
      ...(attribute.type === "number" ? { min: attribute.min, max: attribute.max, step: "any" } : {}),
    },
    value,
    checked: value === "true",
    choices: offered ? [...offered] : attribute.type === "boolean" ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] : attribute.choices ?? [],
  } as const;
}
