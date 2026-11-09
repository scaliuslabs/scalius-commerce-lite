import type { CheckoutAttribute } from "@scalius/shared/plugins/buyer-ui";

/**
 * One host-owned field description for server forms and private buyer UI.
 * `computed` are the choices an extension offered for a `text` attribute this
 * render (a select of them; the answer stays text the app checks).
 */
export function buyerFieldModel(attribute: CheckoutAttribute, name = attribute.key, value = "", computed?: ReadonlyArray<{ value: string; label: string }>) {
  const offered = attribute.type === "text" && computed?.length ? computed : null;
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
