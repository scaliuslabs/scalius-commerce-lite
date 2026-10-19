/**
 * The billing address checks checkout makes before the payment step: the
 * same country rules the API applies when the order is placed
 * (`resolveBillingAddress`), so a required field left empty, or a postal
 * code its country does not use, is said at the field instead of after the
 * buyer chose how to pay. The browser checks with the rules it loaded
 * (billing-address-rules.ts); the no-JavaScript checkout with the rules it
 * read on the server. The API decides either way.
 */
import { validatePostalAddress, type AddressField, type AddressRules } from "@scalius/shared/address";
import {
  billingAddressFields,
  billingAddressNeed,
  MINIMAL_BILLING_IGNORED_FIELDS,
  type BillingAddressMode,
  type BillingCheckoutPath,
} from "@scalius/shared/billing-address";
import { formatCheckoutLanguageText } from "@scalius/shared/checkout-language-format";
import type { CheckoutLanguageData } from "@scalius/shared/checkout-language";
import { BILLING_ADDRESS_FIELDS, BILLING_FIELD_RULE, type BillingAddressField } from "./billing-address";

export type BillingFieldProblem = "required" | "invalid";

const FIELD_BY_RULE = new Map<string, BillingAddressField>(
  BILLING_ADDRESS_FIELDS.map((field) => [BILLING_FIELD_RULE[field], field]),
);

/**
 * Whether checkout asks this order for a billing address it must check: an
 * order that ships nothing always; one that ships or is picked up only when
 * the merchant requires a full billing address, and a shipped one only with
 * "Same as shipping address" unticked.
 */
export function billingAddressAsked(input: {
  path: BillingCheckoutPath;
  requireFullBillingAddress: boolean;
  sameAsShipping: boolean;
}): { asked: false } | { asked: true; mode: BillingAddressMode } {
  const need = billingAddressNeed({ path: input.path, requireFullBillingAddress: input.requireFullBillingAddress });
  if (!need.asked || (need.sameAsShippingOffered && input.sameAsShipping)) return { asked: false };
  return { asked: true, mode: need.mode };
}

/** The billing fields a mode's address must fill in a country (a minimal one only its required region and postal code). */
export function billingRequiredFields(rules: AddressRules, mode: BillingAddressMode): BillingAddressField[] {
  const shown = new Set(billingAddressFields(rules, mode));
  return BILLING_ADDRESS_FIELDS.filter((field) => {
    const rule = BILLING_FIELD_RULE[field] as AddressField;
    return shown.has(rule) && rules.requiredFields.includes(rule);
  });
}

/** The billing fields the country's rules refuse, in form order (empty when the address is fine). */
export function billingAddressProblems(
  rules: AddressRules,
  mode: BillingAddressMode,
  values: Partial<Record<BillingAddressField, string | null | undefined>>,
): Array<{ field: BillingAddressField; problem: BillingFieldProblem }> {
  const { issues } = validatePostalAddress({
    countryCode: rules.countryCode,
    name: values.billingName,
    company: values.billingCompany,
    line1: values.billingAddress,
    line2: values.billingAddressLine2,
    dependentLocality: values.billingDependentLocality,
    locality: values.billingLocality,
    adminArea: values.billingAdminArea,
    postalCode: values.billingPostalCode,
  }, rules, { ignore: mode === "minimal" ? MINIMAL_BILLING_IGNORED_FIELDS : [] });
  const problems = new Map<BillingAddressField, BillingFieldProblem>();
  for (const issue of issues) {
    const field = FIELD_BY_RULE.get(issue.field as AddressField);
    if (field && !problems.has(field)) problems.set(field, issue.code === "required" ? "required" : "invalid");
  }
  return BILLING_ADDRESS_FIELDS.flatMap((field) => {
    const problem = problems.get(field);
    return problem ? [{ field, problem }] : [];
  });
}

/** What the field says: "City is required.", "Enter a valid postal code.", "Choose a region from the list." */
export function billingProblemMessage(
  field: BillingAddressField,
  problem: BillingFieldProblem,
  label: string,
  copy: Pick<CheckoutLanguageData, "billingFieldRequiredText" | "billingPostalCodeInvalidText" | "billingAdminAreaInvalidText">,
): string {
  if (problem === "required") return formatCheckoutLanguageText(copy.billingFieldRequiredText, { field: label });
  return field === "billingPostalCode"
    ? copy.billingPostalCodeInvalidText
    : field === "billingAdminArea"
      ? copy.billingAdminAreaInvalidText
      : formatCheckoutLanguageText(copy.billingFieldRequiredText, { field: label });
}
