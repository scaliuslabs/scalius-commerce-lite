import {
  assistantMessagePartSchema,
  type AssistantMessagePart,
} from "@scalius/shared/assistant-contracts";

import {
  compactStorefrontChatText,
  isJsonRecord,
  type JsonRecord,
  type StorefrontChatPayload,
  type StorefrontMcpContext,
} from "./storefront-chat-contract";
import { resolveStorefrontNavigationTarget } from
  "./storefront-chat-navigation";
import {
  classifyStorefrontChatIntent,
  storefrontIntentPrefersCurrentProduct,
  type StorefrontChatIntent,
} from "./storefront-chat-intent";

const MAX_RICH_PRODUCTS = 5;
const SENSITIVE_IMAGE_QUERY_NAME =
  /(?:auth|credential|email|jwt|key|mobile|otp|pass|phone|proof|receipt|recovery|secret|session|sig|signature|token)/i;
const SENSITIVE_IMAGE_QUERY_VALUE =
  /(?:\bBearer\s+|(?:chk|cst|otp|tok|token|session|secret|sk|pk)_[A-Za-z0-9_-]{6,}|[A-Fa-f0-9]{32,})/i;

type ProductCard = Extract<
  AssistantMessagePart,
  { type: "product_grid" }
>["products"][number];

type CatalogProjection = {
  card: ProductCard;
  optionNames: string[];
  optionDetails: string[];
  priceText: string | null;
  pricePresentation: "exact" | "starting_at" | null;
  availabilityText: string;
  exactSelection: boolean;
  sourceTool: StorefrontMcpContext["tool"];
};

type CatalogSelection = {
  products: CatalogProjection[];
  source: "current_product" | "search" | "visible_listing" | "fallback";
  searchEvidence:
    | "verified_empty"
    | "verified_products"
    | "invalid"
    | "unverified";
};

type Money = {
  amount: number;
  currency: string;
};

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord => isJsonRecord(item))
    : [];
}

function compactString(value: unknown, maxLength: number): string | null {
  return compactStorefrontChatText(value, maxLength);
}

/**
 * Catalog resource IDs are trusted structured MCP data, not conversational
 * text. Validate their exact public identifier grammar without running the
 * secret redactor: persisted SKU IDs can legitimately contain long random or
 * hexadecimal segments that resemble bearer tokens.
 */
function compactResourceReference(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 &&
      normalized.length <= 240 &&
      /^[A-Za-z0-9][A-Za-z0-9._:/~-]*$/.test(normalized)
    ? normalized
    : null;
}

function safeImageUrl(value: unknown): string | undefined {
  const text = compactString(value, 1_000);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return undefined;
    }
    for (const [name, queryValue] of url.searchParams) {
      if (
        SENSITIVE_IMAGE_QUERY_NAME.test(name) ||
        SENSITIVE_IMAGE_QUERY_VALUE.test(queryValue)
      ) {
        return undefined;
      }
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function firstImage(product: JsonRecord, variant: JsonRecord | null) {
  for (const candidate of [variant?.media, product.media]) {
    for (const media of records(candidate)) {
      if (media.type !== "image") continue;
      const url = safeImageUrl(media.url);
      if (url) return url;
    }
  }
  return undefined;
}

function selectedCatalogVariant(
  variants: JsonRecord[],
  optionAxes: string[],
  surface: Extract<
    NonNullable<StorefrontChatPayload["pageContext"]>["surface"],
    { kind: "product" }
  > | null,
): { variant: JsonRecord | null; exact: boolean } {
  if (variants.length === 0) return { variant: null, exact: false };
  const selectedVariantId = surface?.selectedVariantId;
  if (selectedVariantId) {
    const exactVariant = variants.find((variant) => {
      const metadata = isJsonRecord(variant.metadata) ? variant.metadata : null;
      const rawId = compactResourceReference(metadata?.variant_id);
      const publicId = compactResourceReference(variant.id);
      return rawId === selectedVariantId ||
        publicId === selectedVariantId ||
        publicId?.endsWith(`/${selectedVariantId}`) === true;
    });
    if (exactVariant) return { variant: exactVariant, exact: true };
  }

  const selectedOptions = surface?.selectedOptions ?? [];
  const selectedNames = new Set(
    selectedOptions.map((option) => option.name.toLocaleLowerCase()),
  );
  const completeOptionSelection = optionAxes.length > 0 &&
    selectedNames.size === optionAxes.length &&
    optionAxes.every((axis) => selectedNames.has(axis.toLocaleLowerCase()));
  if (selectedOptions.length > 0 && completeOptionSelection) {
    const exactVariant = variants.find((variant) => {
      const variantOptions = optionPairs(variant.options);
      return selectedOptions.every((selected) =>
        variantOptions.some((option) =>
          option.name.toLocaleLowerCase() ===
              selected.name.toLocaleLowerCase() &&
          option.label.toLocaleLowerCase() ===
              selected.label.toLocaleLowerCase()
        )
      );
    });
    if (exactVariant) return { variant: exactVariant, exact: true };
  }
  const exactInputVariants = variants.filter((variant) =>
    records(variant.inputs).some((input) => input.match === "exact")
  );
  if (exactInputVariants.length === 1) {
    return { variant: exactInputVariants[0]!, exact: true };
  }
  return { variant: variants[0] ?? null, exact: false };
}

function hasFeaturedVariantInput(variant: JsonRecord | null): boolean {
  return Boolean(
    variant && records(variant.inputs).some((input) => input.match === "featured"),
  );
}

function currencyFractionDigits(currency: string): number {
  try {
    const digits = new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits ?? 2;
    return Math.min(4, Math.max(0, digits));
  } catch {
    return 2;
  }
}

function readMoney(value: unknown): Money | null {
  if (!isJsonRecord(value)) return null;
  const amount = value.amount;
  const currency = compactString(value.currency, 3)?.toUpperCase();
  if (
    typeof amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    !currency ||
    !/^[A-Z]{3}$/.test(currency)
  ) {
    return null;
  }
  return { amount, currency };
}

function majorAmount(money: Money): number {
  return money.amount / 10 ** currencyFractionDigits(money.currency);
}

function formatMoney(money: Money): string {
  const value = majorAmount(money);
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: money.currency,
      currencyDisplay: "code",
    }).format(value);
  } catch {
    return `${money.currency} ${value.toFixed(2)}`;
  }
}

function productPath(product: JsonRecord, origin: string | null): string | null {
  const candidates = [product.url, product.path];
  const handle = compactString(product.handle, 160);
  if (handle) candidates.push(`/products/${handle}`);
  for (const candidate of candidates) {
    const path = resolveStorefrontNavigationTarget(candidate, origin);
    if (path?.startsWith("/products/")) return path;
  }
  return null;
}

function optionPairs(value: unknown): Array<{ name: string; label: string }> {
  return records(value)
    .slice(0, 4)
    .flatMap((option) => {
      const name = compactString(option.name, 80);
      const label = compactString(option.label, 120);
      return name && label ? [{ name, label }] : [];
    });
}

function productOptionNames(product: JsonRecord): string[] {
  return records(product.options)
    .slice(0, 4)
    .flatMap((option) => {
      const name = compactString(option.name, 80);
      return name ? [name] : [];
    });
}

function productOptionDetails(product: JsonRecord): string[] {
  return records(product.options)
    .slice(0, 4)
    .flatMap((option) => {
      const name = compactString(option.name, 80);
      const values = records(option.values)
        .slice(0, 12)
        .flatMap((value) => {
          const label = compactString(value.label, 80);
          return label ? [label] : [];
        });
      return name && values.length > 0
        ? [`${name}: ${Array.from(new Set(values)).join(", ")}`]
        : [];
    });
}

function availability(
  product: JsonRecord,
  variants: JsonRecord[],
  preferProductAvailability: boolean,
): { value: ProductCard["availability"]; text: string } {
  const productAvailableForSale = isJsonRecord(product.metadata)
    ? product.metadata.available_for_sale
    : undefined;
  if (preferProductAvailability && productAvailableForSale === true) {
    return { value: "in_stock", text: "In stock" };
  }
  if (preferProductAvailability && productAvailableForSale === false) {
    return { value: "out_of_stock", text: "Out of stock" };
  }
  const availabilityRows = variants
    .map((variant) => isJsonRecord(variant.availability)
      ? variant.availability
      : null)
    .filter((value): value is JsonRecord => value !== null);
  const availableVariants = availabilityRows.filter(
    (value) => value.available === true || value.status === "in_stock",
  );
  if (availableVariants.length > 0) {
    const selectedMetadata = isJsonRecord(variants[0]?.metadata)
      ? variants[0]?.metadata
      : null;
    const quantity = selectedMetadata?.available_quantity;
    if (
      variants.length === 1 &&
      typeof quantity === "number" &&
      Number.isFinite(quantity) &&
      quantity > 0 &&
      quantity <= 5
    ) {
      return { value: "limited", text: "Limited stock" };
    }
    return { value: "in_stock", text: "In stock" };
  }
  if (availabilityRows.length > 0) {
    return { value: "out_of_stock", text: "Out of stock" };
  }
  if (
    isJsonRecord(product.metadata) &&
    product.metadata.available_for_sale === false
  ) {
    return { value: "out_of_stock", text: "Out of stock" };
  }
  return { value: "unknown", text: "Availability unknown" };
}

function productMoney(
  product: JsonRecord,
  selectedVariant: JsonRecord | null,
  useVariantPair: boolean,
): {
  price: Money | null;
  listPrice: Money | null;
  presentation: "exact" | "starting_at" | null;
} {
  const priceRange = isJsonRecord(product.price_range)
    ? product.price_range
    : null;
  const variantPrice = selectedVariant ? readMoney(selectedVariant.price) : null;
  const variantListPrice = selectedVariant
    ? readMoney(selectedVariant.list_price)
    : null;
  if (useVariantPair) {
    return {
      price: variantPrice,
      listPrice: variantPrice &&
          variantListPrice?.currency === variantPrice.currency
        ? variantListPrice
        : null,
      presentation: variantPrice ? "exact" : null,
    };
  }
  const rangePrice = readMoney(priceRange?.min);
  return {
    price: rangePrice,
    listPrice: null,
    presentation: rangePrice ? "starting_at" : null,
  };
}

function tagBadges(product: JsonRecord): string[] {
  if (!Array.isArray(product.tags)) return [];
  return product.tags.slice(0, 6).flatMap((tag) => {
    const text = compactString(tag, 60);
    if (!text) return [];
    if (text === "free_delivery") return ["Free delivery"];
    const separator = text.indexOf(":");
    return separator > 0
      ? [`${text.slice(0, separator)}: ${text.slice(separator + 1)}`]
      : [];
  });
}

function mapCatalogProduct(
  product: JsonRecord,
  context: StorefrontMcpContext,
  payload: StorefrontChatPayload,
  origin: string | null,
  applyPageSelection: boolean,
): CatalogProjection | null {
  const id = compactResourceReference(product.id);
  const title = compactString(product.title, 240);
  const path = productPath(product, origin);
  if (!id || !title || !path) return null;

  const variants = records(product.variants);
  const optionNames = productOptionNames(product);
  const currentProductSurface = payload.pageContext?.surface?.kind === "product"
    ? payload.pageContext.surface
    : null;
  const isCurrentProduct =
    context.tool === "catalog_product" && applyPageSelection;
  const selection = selectedCatalogVariant(
    variants,
    optionNames,
    isCurrentProduct ? currentProductSurface : null,
  );
  const selectedVariant = selection.variant;
  const useSelectedVariant = isCurrentProduct && selection.exact;
  const useVariantPair = selection.exact ||
    (variants.length === 1 && !hasFeaturedVariantInput(selectedVariant));
  const pricing = productMoney(product, selectedVariant, useVariantPair);
  const stock = availability(
    product,
    selection.exact && selectedVariant ? [selectedVariant] : variants,
    !selection.exact,
  );
  const selectedOptions = isCurrentProduct
    ? currentProductSurface?.selectedOptions ?? []
    : useVariantPair && selectedVariant
      ? optionPairs(selectedVariant.options)
      : [];
  const badges = Array.from(new Set([
    ...selectedOptions.map((option) => `${option.name}: ${option.label}`),
    ...tagBadges(product),
  ])).slice(0, 6);
  const imageUrl = firstImage(product, selectedVariant);
  const selectedVariantId = selectedVariant && useVariantPair
    ? compactResourceReference(selectedVariant.id)
    : null;

  const candidate: ProductCard = {
    id,
    title,
    path,
    ...(imageUrl ? { imageUrl } : {}),
    ...(pricing.price
      ? {
          price: majorAmount(pricing.price),
          currency: pricing.price.currency,
          ...(pricing.presentation
            ? { pricePresentation: pricing.presentation }
            : {}),
        }
      : {}),
    ...(pricing.listPrice &&
        pricing.price &&
        pricing.listPrice.currency === pricing.price.currency &&
        pricing.listPrice.amount > pricing.price.amount
      ? { compareAtPrice: majorAmount(pricing.listPrice) }
      : {}),
    availability: stock.value,
    ...(selectedVariantId ? { selectedVariantId } : {}),
    badges,
  };
  const parsed = assistantMessagePartSchema.safeParse({
    type: "product_grid",
    products: [candidate],
  });
  if (!parsed.success || parsed.data.type !== "product_grid") return null;

  return {
    card: parsed.data.products[0]!,
    optionNames,
    optionDetails: productOptionDetails(product),
    priceText: pricing.price
      ? `${pricing.presentation === "starting_at" ? "Starting at " : ""}${formatMoney(pricing.price)}`
      : null,
    pricePresentation: pricing.presentation,
    availabilityText: stock.text,
    exactSelection: useSelectedVariant,
    sourceTool: context.tool,
  };
}

function contextProducts(context: StorefrontMcpContext): JsonRecord[] {
  if (context.tool === "catalog_product") {
    return isJsonRecord(context.structuredContent.product)
      ? [context.structuredContent.product]
      : [];
  }
  if (context.tool === "catalog_search" || context.tool === "catalog_lookup") {
    return records(context.structuredContent.products);
  }
  return [];
}

function mappedProducts(
  contexts: StorefrontMcpContext[],
  tool: StorefrontMcpContext["tool"],
  payload: StorefrontChatPayload,
  origin: string | null,
  applyPageSelection = false,
): CatalogProjection[] {
  const seen = new Set<string>();
  const output: CatalogProjection[] = [];
  for (const context of contexts) {
    if (context.tool !== tool) continue;
    for (const product of contextProducts(context)) {
      const mapped = mapCatalogProduct(
        product,
        context,
        payload,
        origin,
        applyPageSelection,
      );
      if (!mapped || seen.has(mapped.card.id)) continue;
      seen.add(mapped.card.id);
      output.push(mapped);
      if (output.length >= MAX_RICH_PRODUCTS) return output;
    }
  }
  return output;
}

function catalogSearchEvidence(
  contexts: StorefrontMcpContext[],
  payload: StorefrontChatPayload,
  origin: string | null,
): CatalogSelection["searchEvidence"] {
  let sawEmpty = false;
  let sawInvalid = false;
  let sawProducts = false;
  for (const context of contexts) {
    if (context.tool !== "catalog_search") continue;
    const ucp = isJsonRecord(context.structuredContent.ucp)
      ? context.structuredContent.ucp
      : null;
    if (ucp?.status !== "success") continue;
    const rawProducts = context.structuredContent.products;
    if (!Array.isArray(rawProducts)) {
      sawInvalid = true;
      continue;
    }
    if (rawProducts.length === 0) {
      sawEmpty = true;
      continue;
    }
    if (mappedProducts([context], "catalog_search", payload, origin).length > 0) {
      sawProducts = true;
    } else {
      sawInvalid = true;
    }
  }
  if (sawProducts) return "verified_products";
  if (sawInvalid) return "invalid";
  if (sawEmpty) return "verified_empty";
  return "unverified";
}

function chooseCatalogProducts(
  contexts: StorefrontMcpContext[],
  payload: StorefrontChatPayload,
  origin: string | null,
  intent: StorefrontChatIntent,
): CatalogSelection {
  const searched = mappedProducts(
    contexts,
    "catalog_search",
    payload,
    origin,
  );
  const current = mappedProducts(
    contexts,
    "catalog_product",
    payload,
    origin,
    storefrontIntentPrefersCurrentProduct(intent, payload),
  );
  const visible = mappedProducts(
    contexts,
    "catalog_lookup",
    payload,
    origin,
  );
  const searchEvidence = catalogSearchEvidence(contexts, payload, origin);
  const referencedIds = intent.referencedProductIds ?? [];
  if (intent.unresolvedOrdinalReference) {
    return { products: [], source: "fallback", searchEvidence };
  }
  if (intent.kind === "ordinal_product") {
    const referenced = referencedIds.length === 1
      ? current.filter((product) => product.card.id === referencedIds[0])
      : [];
    return { products: referenced, source: "current_product", searchEvidence };
  }
  if (
    referencedIds.length > 1 &&
    (intent.kind === "factual_comparison" ||
      intent.kind === "recommendation_comparison")
  ) {
    const byId = new Map(visible.map((product) => [product.card.id, product]));
    const referenced = referencedIds.flatMap((id) => {
      const product = byId.get(id);
      return product ? [product] : [];
    });
    return {
      products: referenced.length === referencedIds.length ? referenced : [],
      source: "visible_listing",
      searchEvidence,
    };
  }
  if (storefrontIntentPrefersCurrentProduct(intent, payload)) {
    return { products: current, source: "current_product", searchEvidence };
  }
  if (
    intent.kind === "factual_comparison" ||
    intent.kind === "recommendation_comparison"
  ) {
    if (visible.length > 0) {
      return { products: visible, source: "visible_listing", searchEvidence };
    }
    if (searchEvidence === "verified_products") {
      return { products: searched, source: "search", searchEvidence };
    }
  }
  if (
    (intent.kind === "catalog_search" || intent.kind === "recommendation") &&
    intent.searchQuery
  ) {
    return { products: searched, source: "search", searchEvidence };
  }
  if (visible.length > 0) {
    return {
      products: visible,
      source: "visible_listing",
      searchEvidence,
    };
  }
  if (current.length > 0) {
    return { products: current, source: "current_product", searchEvidence };
  }
  return { products: searched, source: "fallback", searchEvidence };
}

function currentProductText(
  product: CatalogProjection,
  payload: StorefrontChatPayload,
  intent: StorefrontChatIntent,
): string {
  const surface = payload.pageContext?.surface?.kind === "product"
    ? payload.pageContext.surface
    : null;
  const sentences = [intent.kind === "ordinal_product"
    ? `The referenced product is ${product.card.title}.`
    : `You’re viewing ${product.card.title}.`];
  if (product.priceText) {
    sentences.push(product.pricePresentation === "starting_at"
      ? `Current catalog prices start at ${product.priceText.replace(/^Starting at /, "")}.`
      : `The current catalog price is ${product.priceText}.`);
  } else {
    sentences.push("The current catalog price is unavailable.");
  }

  const requestedOptionDetails = intent.requestedOptionAxes?.length
    ? product.optionDetails.filter((detail) => {
      const axis = detail.slice(0, detail.indexOf(":"))
        .toLocaleLowerCase();
      return intent.requestedOptionAxes!.some((requested) =>
        axis.includes(requested)
      );
    })
    : product.optionDetails;
  if (
    surface?.availability === "selection_required" &&
    !product.exactSelection
  ) {
    const names = product.optionNames.length > 0
      ? product.optionNames.join(" and ")
      : "the required options";
    sentences.push(
      `Choose ${names} to select an exact variant and confirm its availability.`,
    );
  } else if (product.exactSelection) {
    const selection = (surface?.selectedOptions ?? [])
      .map((option) => `${option.name}: ${option.label}`)
      .join(", ");
    const subject = selection
      ? `The selected ${selection} variant`
      : "The selected variant";
    sentences.push(`${subject} is ${product.availabilityText.toLowerCase()}.`);
  } else {
    sentences.push(`Catalog availability: ${product.availabilityText}.`);
  }
  if (
    /\b(?:sizes?|colou?rs?|options?|variants?|materials?|patterns?)\b/i.test(
      intent.latestText,
    ) &&
    requestedOptionDetails.length > 0
  ) {
    sentences.push(`Catalog options: ${requestedOptionDetails.join("; ")}.`);
  }
  return sentences.join(" ");
}

function catalogAnswerText(
  selection: CatalogSelection,
  payload: StorefrontChatPayload,
  intent: StorefrontChatIntent,
  modelText: string,
): string {
  const referencedProductIds = intent.referencedProductIds ?? [];
  if (
    intent.unresolvedOrdinalReference ||
    (referencedProductIds.length > 0 &&
      selection.products.length !== referencedProductIds.length)
  ) {
    return "I can’t resolve every referenced item from the immediately preceding catalog results. Please name the product or ask me to show the results again.";
  }
  if (intent.kind === "ordinal_product" && selection.products.length === 0) {
    return "I can’t resolve that referenced item from the current public catalog. Please name the product or ask me to show the results again.";
  }
  if (
    selection.source === "current_product" &&
    selection.products[0] &&
    (intent.kind === "current_product" ||
      intent.kind === "ordinal_product" ||
      !modelText)
  ) {
    return currentProductText(selection.products[0], payload, intent);
  }
  if (intent.searchQuery && selection.source === "search") {
    if (
      selection.searchEvidence === "invalid" ||
      selection.searchEvidence === "unverified"
    ) {
      return modelText;
    }
    if (intent.kind !== "catalog_search" && modelText) {
      return modelText;
    }
    if (
      selection.products.length === 0 &&
      selection.searchEvidence === "verified_empty"
    ) {
      return `I couldn’t find a current catalog match for “${intent.searchQuery}”.`;
    }
    if (selection.products.length > 0) {
      if (selection.products.length === 1) {
        const requestedOptionDetails = intent.requestedOptionAxes?.length
          ? selection.products[0]!.optionDetails.filter((detail) => {
            const axis = detail.slice(0, detail.indexOf(":"))
              .toLocaleLowerCase();
            return intent.requestedOptionAxes!.some((requested) =>
              axis.includes(requested)
            );
          })
          : selection.products[0]!.optionDetails;
        const optionFacts = requestedOptionDetails.length > 0 &&
            /\b(?:sizes?|colou?rs?|options?|variants?|materials?|patterns?)\b/i.test(
              intent.latestText,
            )
          ? ` Catalog options: ${requestedOptionDetails.join("; ")}.`
          : "";
        return `I found ${selection.products[0]!.card.title}, a current catalog match for “${intent.searchQuery}”. Its price and availability below come from the public catalog.${optionFacts}`;
      }
      return `I found ${selection.products.length} current catalog ${
        selection.products.length === 1 ? "match" : "matches"
      } for “${intent.searchQuery}”. Prices and availability below come from the public catalog.`;
    }
  }
  if (
    intent.kind === "factual_comparison" &&
    selection.products.length >= 2
  ) {
    return "Here’s a catalog-backed comparison of the visible options. Unknown facts are shown as unavailable rather than guessed.";
  }
  if (
    intent.kind === "recommendation_comparison" &&
    selection.products.length >= 2 &&
    !modelText
  ) {
    return "Here are the verified catalog facts for those options. I couldn’t complete the preference recommendation, so I’m not guessing which one fits your use case best.";
  }
  if (modelText) {
    return modelText;
  }
  if (selection.products.length > 0) {
    return `Here ${selection.products.length === 1 ? "is" : "are"} ${
      selection.products.length
    } catalog-backed ${selection.products.length === 1 ? "option" : "options"}.`;
  }
  return modelText;
}

function comparisonPart(
  products: CatalogProjection[],
): AssistantMessagePart | null {
  const compared = products.slice(0, 5);
  if (compared.length < 2) return null;
  const candidate = {
    type: "comparison" as const,
    title: "Catalog comparison",
    products: compared.map((product) => product.card),
    rows: [
      {
        label: "Price",
        cells: compared.map((product) => ({
          productId: product.card.id,
          value: product.priceText,
          status: product.priceText ? "known" as const : "unknown" as const,
        })),
      },
      {
        label: "Availability",
        cells: compared.map((product) => ({
          productId: product.card.id,
          value: product.availabilityText,
          status: product.card.availability === "unknown"
            ? "unknown" as const
            : "known" as const,
        })),
      },
      {
        label: "Options",
        cells: compared.map((product) => ({
          productId: product.card.id,
          value: product.optionNames.length > 0
            ? product.optionNames.join(", ")
            : null,
          status: product.optionNames.length > 0
            ? "known" as const
            : "not_applicable" as const,
        })),
      },
    ],
  };
  const parsed = assistantMessagePartSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function buildStorefrontAssistantResponse(input: {
  modelText: string;
  contexts: StorefrontMcpContext[];
  payload: StorefrontChatPayload;
  origin: string | null;
  searchQuery: string | null;
  intent?: StorefrontChatIntent;
}): {
  text: string;
  parts: AssistantMessagePart[];
  deterministic: boolean;
  hasCatalogFacts: boolean;
} {
  const intent = input.intent ?? classifyStorefrontChatIntent(
    input.payload,
    input.searchQuery,
  );
  const selection = chooseCatalogProducts(
    input.contexts,
    input.payload,
    input.origin,
    intent,
  );
  const text = catalogAnswerText(
    selection,
    input.payload,
    intent,
    input.modelText,
  );
  const comparisonIntent = intent.kind === "factual_comparison" ||
    intent.kind === "recommendation_comparison";
  const referencedProductIds = intent.referencedProductIds ?? [];
  const referenceResolutionFailed = referencedProductIds.length > 0 &&
    selection.products.length !== referencedProductIds.length;
  const deterministic = Boolean(
    intent.unresolvedOrdinalReference ||
    referenceResolutionFailed ||
    intent.kind === "ordinal_product" ||
    (intent.kind === "catalog_search" &&
      (selection.searchEvidence === "verified_empty" ||
        (selection.searchEvidence === "verified_products" &&
          selection.products.length > 0))) ||
    (intent.kind === "current_product" && selection.products.length > 0) ||
    (intent.kind === "factual_comparison" &&
      selection.products.length >= 2),
  );
  const parts: AssistantMessagePart[] = text
    ? [{ type: "text", text }]
    : [];
  const comparison = comparisonIntent
    ? comparisonPart(selection.products)
    : null;
  if (comparison) {
    parts.push(comparison);
  } else if (selection.products.length > 0) {
    const title = intent.searchQuery && selection.source === "search"
      ? `Matches for “${intent.searchQuery}”`
      : selection.source === "current_product"
        ? intent.kind === "ordinal_product"
          ? "Referenced product"
          : "Current product"
        : "Products from this page";
    const parsed = assistantMessagePartSchema.safeParse({
      type: "product_grid",
      title,
      products: selection.products.map((product) => product.card),
    });
    if (parsed.success) parts.push(parsed.data);
  }
  return {
    text,
    parts,
    deterministic,
    hasCatalogFacts: selection.source === "search"
      ? selection.searchEvidence === "verified_empty" ||
        (selection.searchEvidence === "verified_products" &&
          selection.products.length > 0)
      : selection.products.length > 0,
  };
}
