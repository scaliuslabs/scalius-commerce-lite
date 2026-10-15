import type { CheckoutAttribute } from "@scalius/shared/plugins/buyer-ui";

/** One host-owned field description for server forms and private buyer UI. */
export function buyerFieldModel(attribute: CheckoutAttribute, name = attribute.key, value = "") {
  const tag = attribute.type === "multiline" ? "textarea" : attribute.type === "choice" || (attribute.type === "boolean" && attribute.required) ? "select" : "input";
  const inputType: "checkbox" | "number" | "date" | "text" = attribute.type === "boolean" ? "checkbox" : attribute.type === "number" || attribute.type === "date" ? attribute.type : "text";
  return {
    tag,
    attributes: {
      name,
      required: attribute.required === true,
      ...(tag === "input" ? { type: inputType } : {}),
      ...(attribute.type === "text" || attribute.type === "multiline" ? { maxlength: attribute.maxLength ?? 500 } : {}),
      ...(attribute.type === "number" ? { min: attribute.min, max: attribute.max, step: "any" } : {}),
    },
    value,
    checked: value === "true",
    choices: attribute.type === "boolean" ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] : attribute.choices ?? [],
  } as const;
}
