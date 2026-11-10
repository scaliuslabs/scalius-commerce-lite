// The app line inputs a buyer's checkout needs answered (manifest
// `checkout.lineInputs[].decision`): an eligible line left undecided (no
// plan chosen and none declined) is refused before an order is placed, by
// whatever path the buyer took (the storefront API, the no-script checkout,
// an agent's checkout). The cart check never refuses it: a line joins the
// cart undecided and the cart asks for the decision. Staff and app orders
// are not refused (nobody there can give the buyer's agreement); they place
// an undecided line as unanswered. Pure.
import type { AppLineInputs } from "@scalius/shared/line-properties";
import type { StorefrontCartItemIssue, StorefrontCartValidatedItem } from "./cart-validation";

type DecidedLine = Pick<
    StorefrontCartValidatedItem,
    "index" | "cartKey" | "productId" | "variantId" | "quantity" | "productName" | "variantLabel" | "properties" | "lineInputs"
> & Partial<Pick<StorefrontCartValidatedItem, "sourceIndex" | "bundle">>;

/**
 * One `decision_required` issue per buyer line and input that needs a
 * decision and has no answer, in line order. An expanded bundle
 * (`cart.transform`) is one line, the buyer's: its answers and the inputs
 * that apply to the bundle SKU (`CartLineBundle`), asked once whatever its
 * components are, and named on the buyer's line. Merged lines stay their own.
 */
export function undecidedLineIssues(lines: readonly DecidedLine[], apps: readonly AppLineInputs[]): StorefrontCartItemIssue[] {
    const needed = new Map<string, string>();
    for (const app of apps) {
        for (const input of app.inputs) if (input.decision) needed.set(`${app.appId}.${input.key}`, input.label);
    }
    if (needed.size === 0) return [];
    const issues: StorefrontCartItemIssue[] = [];
    const bundles = new Set<string>();
    for (const line of lines) {
        const bundle = line.bundle?.kind === "expand" ? line.bundle : null;
        if (bundle) {
            if (bundles.has(bundle.id)) continue;
            bundles.add(bundle.id);
        }
        const keys = bundle ? bundle.lineInputs ?? [] : line.lineInputs ?? [];
        const answers = bundle ? bundle.properties ?? [] : line.properties;
        const productName = bundle ? bundle.title : line.productName;
        const variantLabel = bundle ? null : line.variantLabel;
        for (const key of keys) {
            const label = needed.get(key);
            if (label === undefined || answers.some((property) => property.key === key)) continue;
            const name = variantLabel ? `${productName} (${variantLabel})` : productName;
            issues.push({
                index: line.sourceIndex ?? line.index,
                cartKey: line.cartKey ?? null,
                productId: line.productId,
                variantId: line.variantId,
                code: "decision_required",
                action: "edit_properties",
                message: `Choose "${label}" for ${name} before checkout.`,
                productName,
                variantLabel,
                requestedQuantity: bundle?.units ?? line.quantity,
                propertyKey: key,
            });
        }
    }
    return issues;
}
