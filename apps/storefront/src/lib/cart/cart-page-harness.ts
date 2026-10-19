/**
 * Test harness for the `pages/cart.astro` page script.
 *
 * The page script is plain code with static imports. Tests run it inside
 * `new Function(...)`, so each import must arrive as a parameter. This module
 * is the one place that knows the import list: it supplies the real module
 * export for every imported name, and a test replaces only what it needs.
 * A new import in the page script is then covered here once, not by editing
 * every test. A name no one supplies fails loudly, not as a ReferenceError
 * deep inside a test.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { formatCheckoutLanguageText } from "@scalius/shared/checkout-language-format";
import { formatMoney } from "@scalius/shared/currency";
import { getCustomerSession } from "../api/customer-auth";
import { browserApiUrl } from "../api/browser-url";
import { readBuyerAttributes } from "../buyer-ui";
import { pagePath } from "../presence-url";
import { addressAutocompleteService, pageLocale } from "../app-services";
import { storefrontSourcePath } from "../test-source-paths";
import {
  cartHasFreeDeliveryItem,
  cartItemsSubtotal,
  cartNeedsDeliveryMethod,
  cartStore,
  getEffectiveCartShippingFee,
} from "../../store/cart";
import {
  initCartFunctionality,
  isDiscountValidationPending,
  refreshCartBlockingState,
  resumeCartPageFromHistory,
  updateCheckoutButtonState,
  updateTotals,
} from "./client";
import { BILLING_ADDRESS_FIELDS, checkoutBillingFields } from "../checkout/billing-address";
import { enhanceBillingAddress } from "../checkout/billing-address-rules";
import { enhanceShippingMethods, fetchDeliveryRates } from "../checkout/shipping-methods";
import {
  applyCheckoutDeliveryMode,
  checkoutTransferPath,
  readCheckoutDeliveryMode,
} from "../checkout/delivery-mode";
import {
  enhanceLocationSelects,
  fetchLocationOptions,
} from "../checkout/location-select";
import {
  checkoutPhoneResult,
  initCheckoutPhoneField,
  loadCheckoutPhoneValidator,
} from "../checkout/phone-field";
import { phoneHintCopy } from "../checkout/phone-hint";
import {
  applyCheckoutContactNeeds,
  checkoutContactNeeds,
  readCheckoutPhoneNeed,
} from "../checkout/contact-need";
import {
  clearCheckoutFormDraft,
  discardCheckoutFormDraftOfOtherOwner,
  readCheckoutFormDraft,
  readHostedPaymentRecoverySession,
  syncCheckoutTransferSession,
  writeCheckoutFormDraft,
  writeCheckoutTransferSession,
} from "../checkout/session-state";
import { rememberSubmittedCart } from "../checkout/receipt-finalization";
import { readStoredGiftCards } from "../checkout/gift-cards";
import { findNamedCheckoutControl } from "../checkout/form-controls";
import { shippingCountryName } from "../checkout/shipping-country";
import { enhanceShippingCountry } from "../checkout/country-address";
import {
  checkoutInformationFields,
  enhanceCheckoutFields,
  setFieldError,
} from "../checkout/field-validation";
import {
  hideCheckoutLoadingOverlay,
  showCheckoutLoadingOverlay,
} from "../checkout/loading-overlay";

/** The real export behind every value the page script imports. */
const realImports: Record<string, unknown> = {
  BILLING_ADDRESS_FIELDS,
  addressAutocompleteService,
  applyCheckoutContactNeeds,
  applyCheckoutDeliveryMode,
  browserApiUrl,
  cartHasFreeDeliveryItem,
  cartItemsSubtotal,
  cartNeedsDeliveryMethod,
  cartStore,
  checkoutTransferPath,
  checkoutBillingFields,
  checkoutContactNeeds,
  checkoutInformationFields,
  checkoutPhoneResult,
  clearCheckoutFormDraft,
  discardCheckoutFormDraftOfOtherOwner,
  enhanceCheckoutFields,
  enhanceBillingAddress,
  enhanceLocationSelects,
  enhanceShippingCountry,
  enhanceShippingMethods,
  fetchDeliveryRates,
  fetchLocationOptions,
  findNamedCheckoutControl,
  formatCheckoutLanguageText,
  formatMoney,
  getCustomerSession,
  getEffectiveCartShippingFee,
  hideCheckoutLoadingOverlay,
  initCartFunctionality,
  initCheckoutPhoneField,
  isDiscountValidationPending,
  loadCheckoutPhoneValidator,
  pageLocale,
  pagePath,
  phoneHintCopy,
  readBuyerAttributes,
  readCheckoutDeliveryMode,
  readCheckoutFormDraft,
  readCheckoutPhoneNeed,
  readHostedPaymentRecoverySession,
  readStoredGiftCards,
  refreshCartBlockingState,
  rememberSubmittedCart,
  resumeCartPageFromHistory,
  setFieldError,
  shippingCountryName,
  showCheckoutLoadingOverlay,
  syncCheckoutTransferSession,
  updateCheckoutButtonState,
  updateTotals,
  writeCheckoutFormDraft,
  writeCheckoutTransferSession,
};

const pageSource = readFileSync(storefrontSourcePath("pages", "cart.astro"), "utf8");
const script = pageSource.split("<script>")[1]!.split("</script>")[0]!;
const ast = ts.createSourceFile("cart.ts", script, ts.ScriptTarget.ES2022, true);

/** Names the page script imports as values (type imports erase at build). */
export const cartPageImportNames: readonly string[] = ast.statements
  .filter(ts.isImportDeclaration)
  .flatMap((statement) => {
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) return [];
    const names: string[] = clause.name ? [clause.name.text] : [];
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (!element.isTypeOnly) names.push(element.name.text);
      }
    }
    return names;
  });

/** The page script with its imports removed, as runnable JavaScript. `stopBefore` cuts it at a marker comment. */
export function cartPageScript(stopBefore?: string): string {
  const source = stopBefore ? script.split(stopBefore)[0]! : script;
  const parsed = ts.createSourceFile("cart.ts", source, ts.ScriptTarget.ES2022, true);
  const code = parsed.statements
    .filter((statement) => !ts.isImportDeclaration(statement))
    .map((statement) => statement.getFullText(parsed))
    .join("\n");
  return ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
}

/**
 * One value per name the page script imports: the real export unless the test
 * overrides it. Throws when the script imports a name nobody supplies.
 */
export function cartPageDependencies(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const dependencies: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const name of cartPageImportNames) {
    if (name in overrides) dependencies[name] = overrides[name];
    else if (name in realImports) dependencies[name] = realImports[name];
    else missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(
      `cart-page-harness: pages/cart.astro imports ${missing.join(", ")}; add them to realImports.`,
    );
  }
  return dependencies;
}

/** Run the page script (up to `stopBefore`) with these dependencies; returns what `returning` names. */
export function runCartPageScript(
  overrides: Record<string, unknown> = {},
  options: { stopBefore?: string; returning?: string } = {},
): unknown {
  const dependencies = cartPageDependencies(overrides);
  const body = options.returning
    ? `${cartPageScript(options.stopBefore)}\nreturn ${options.returning};`
    : cartPageScript(options.stopBefore);
  return new Function(...Object.keys(dependencies), body)(...Object.values(dependencies));
}
