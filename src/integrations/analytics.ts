// src/lib/analytics.ts
/**
 * Utility functions for handling analytics scripts and event tracking
 * with Partytown for Facebook Pixel and Google Analytics 4.
 */

// Augment the Window interface for TypeScript to recognize dataLayer and fbq
declare global {
  interface Window {
    dataLayer: any[];
    fbq: (...args: any[]) => void;
  }
}

import type { Analytics as AnalyticsConfig } from "@/db/schema";

/**
 * Processes an analytics script configuration to add Partytown attributes.
 * This function adds the type="text/partytown" attribute to script tags
 * to ensure they run in a web worker via Partytown.
 */
export function processAnalyticsScript(script: AnalyticsConfig): string {
  if (!script.config) return "";

  if (
    !script.config.includes("<script") ||
    script.config.includes("text/partytown")
  ) {
    return script.config;
  }
  return script.config.replace(/<script/g, '<script type="text/partytown"');
}

/**
 * Determines if a script configuration should use Partytown.
 * Respects the usePartytown field from the database configuration.
 */
export function shouldUsePartytown(script: AnalyticsConfig): boolean {
  if (typeof script.usePartytown === "boolean") {
    return script.usePartytown;
  }
  // Fallback to type-based decision if usePartytown is not explicitly set
  const partytownTypes = [
    "google_analytics",
    "facebook_pixel",
    "google_tag_manager",
  ];
  return partytownTypes.includes(script.type) || script.type === "custom";
}

// --- E-commerce Event Tracking ---

// Helper to ensure dataLayer exists for GA4
function getGaDataLayer() {
  window.dataLayer = window.dataLayer || [];
  return window.dataLayer;
}

// --- Event Parameter Interfaces ---

interface ItemParameters {
  item_id?: string; // SKU or product ID
  item_name?: string;
  affiliation?: string; // Store or business name
  coupon?: string;
  currency?: string;
  discount?: number;
  index?: number; // Position in a list
  item_brand?: string;
  item_category?: string;
  item_category2?: string;
  item_category3?: string;
  item_category4?: string;
  item_category5?: string;
  item_list_id?: string; // ID of the list from which the item was selected
  item_list_name?: string; // Name of the list
  item_variant?: string;
  location_id?: string; // For physical stores
  price?: number; // Unit price
  quantity?: number;
}

// --- Facebook Pixel Event Tracking ---

/**
 * Tracks a PageView event for Facebook Pixel.
 * This is often handled by the base Pixel code, but can be called explicitly if needed,
 * for example, on Single Page Application (SPA) navigations.
 */
export function trackFbPageView(): void {
  if (typeof window.fbq === "function") {
    window.fbq("track", "PageView");
    console.debug("FB Pixel: PageView tracked");
  }
}

/**
 * Tracks a ViewContent event for Facebook Pixel.
 * Typically used when a user views a product details page.
 */
export function trackFbViewContent(data: {
  content_ids?: string[]; // Array of product SKUs or IDs
  content_category?: string;
  content_name?: string; // Name of the product or content
  content_type?: "product" | "product_group"; // Typically 'product' for single items
  contents?: Array<{ id: string; quantity: number; item_price?: number }>; // Detailed product info
  currency?: string; // e.g., 'USD'
  value?: number; // Total value of the content viewed
}): void {
  if (typeof window.fbq === "function") {
    window.fbq("track", "ViewContent", data);
  }
}

/**
 * Tracks an AddToCart event for Facebook Pixel.
 */
export function trackFbAddToCart(data: {
  content_ids?: string[];
  content_name?: string;
  content_type?: "product" | "product_group";
  contents?: Array<{ id: string; quantity: number; item_price?: number }>;
  currency?: string;
  value?: number; // Total value of items added
}): void {
  if (typeof window.fbq === "function") {
    window.fbq("track", "AddToCart", data);
  }
}

/**
 * Tracks an InitiateCheckout event for Facebook Pixel.
 */
export function trackFbInitiateCheckout(data: {
  content_ids?: string[];
  content_category?: string;
  content_name?: string; // Often a concatenation of product names or "Checkout"
  contents?: Array<{ id: string; quantity: number; item_price?: number }>;
  currency?: string;
  num_items?: number;
  value?: number; // Total value of the checkout
}): void {
  if (typeof window.fbq === "function") {
    window.fbq("track", "InitiateCheckout", data);
  }
}

/**
 * Tracks an AddPaymentInfo event for Facebook Pixel.
 */
export function trackFbAddPaymentInfo(data?: {
  // Often no specific parameters needed, but can include value/currency
  content_category?: string;
  content_ids?: string[];
  contents?: Array<{ id: string; quantity: number; item_price?: number }>;
  currency?: string;
  value?: number;
}): void {
  if (typeof window.fbq === "function") {
    window.fbq("track", "AddPaymentInfo", data || {});
  }
}

/**
 * Tracks a Purchase event for Facebook Pixel.
 */
export function trackFbPurchase(data: {
  content_ids?: string[]; // IDs of purchased products
  content_name?: string; // Often "Order" or a summary
  content_type?: "product" | "product_group";
  contents?: Array<{ id: string; quantity: number; item_price?: number }>; // Detailed items
  currency: string;
  num_items?: number;
  value: number; // Total order value
  order_id?: string; // Transaction ID - important for deduplication
}): void {
  if (typeof window.fbq === "function") {
    const eventData = { ...data };
    // FB Pixel does not have a direct order_id field at the top level like GA4 purchase.
    // It's often included in custom data or inferred.
    // If `order_id` is passed, it's good for logging/debugging but won't be a standard FB parameter here.
    // For deduplication, FB relies on eventID or combination of parameters.
    // We'll pass all provided data.
    window.fbq("track", "Purchase", eventData);
  }
}

/**
 * Tracks a Lead event for Facebook Pixel.
 * E.g., for newsletter signups or contact form submissions.
 */
export function trackFbLead(data?: {
  content_category?: string;
  content_name?: string; // e.g., "Newsletter Signup"
  currency?: string;
  value?: number; // Optional value for the lead
}): void {
  if (typeof window.fbq === "function") {
    window.fbq("track", "Lead", data || {});
  }
}

/**
 * Tracks a CompleteRegistration event for Facebook Pixel.
 */
export function trackFbCompleteRegistration(data?: {
  content_name?: string;
  currency?: string;
  status?: boolean | string; // e.g., true or "completed"
  value?: number;
}): void {
  if (typeof window.fbq === "function") {
    window.fbq("track", "CompleteRegistration", data || {});
  }
}

/**
 * Tracks a Search event for Facebook Pixel.
 */
export function trackFbSearch(data: {
  content_category?: string; // Category searched within
  content_ids?: string[]; // If search results are specific items
  contents?: Array<{ id: string; quantity: number }>;
  currency?: string;
  search_string: string;
  value?: number; // Optional value associated with search
}): void {
  if (typeof window.fbq === "function") {
    window.fbq("track", "Search", data);
  }
}

// --- Google Analytics 4 (GA4) Event Tracking ---

/**
 * Generic GA4 event tracking function.
 * All specific GA4 event functions will use this.
 */
function trackGA4Event(
  eventName: string,
  parameters: Record<string, any>,
): void {
  const dataLayer = getGaDataLayer();
  dataLayer.push({ ecommerce: null }); // Clear previous ecommerce object (recommended by Google)
  dataLayer.push({
    event: eventName,
    ecommerce: parameters,
  });
}

/**
 * Tracks a view_item_list event for GA4.
 * When a user is presented with a list of items.
 */
export function trackGA4ViewItemList(data: {
  item_list_id?: string;
  item_list_name?: string;
  items: ItemParameters[];
  [key: string]: any; // Allow other event-level params
}): void {
  trackGA4Event("view_item_list", data);
}

/**
 * Tracks a select_item event for GA4.
 * When a user selects an item from a list.
 */
export function trackGA4SelectItem(data: {
  item_list_id?: string;
  item_list_name?: string;
  items: ItemParameters[]; // Typically a single item array
  [key: string]: any;
}): void {
  trackGA4Event("select_item", data);
}

/**
 * Tracks a view_item event for GA4.
 * Typically used when a user views a product details page.
 */
export function trackGA4ViewItem(data: {
  currency?: string;
  value?: number; // Total value of the items viewed
  items: ItemParameters[]; // Typically a single item array
  [key: string]: any;
}): void {
  trackGA4Event("view_item", data);
}

/**
 * Tracks an add_to_cart event for GA4.
 */
export function trackGA4AddToCart(data: {
  currency?: string;
  value?: number; // Total value of items added
  items: ItemParameters[];
  [key: string]: any;
}): void {
  trackGA4Event("add_to_cart", data);
}

/**
 * Tracks a remove_from_cart event for GA4.
 */
export function trackGA4RemoveFromCart(data: {
  currency?: string;
  value?: number; // Total value of items removed
  items: ItemParameters[];
  [key: string]: any;
}): void {
  trackGA4Event("remove_from_cart", data);
}

/**
 * Tracks a view_cart event for GA4.
 */
export function trackGA4ViewCart(data: {
  currency?: string;
  value?: number; // Total value of the cart
  items: ItemParameters[];
  [key: string]: any;
}): void {
  trackGA4Event("view_cart", data);
}

/**
 * Tracks a begin_checkout event for GA4.
 */
export function trackGA4BeginCheckout(data: {
  currency?: string;
  value?: number; // Total value of items in checkout
  coupon?: string;
  items: ItemParameters[];
  [key: string]: any;
}): void {
  trackGA4Event("begin_checkout", data);
}

/**
 * Tracks an add_shipping_info event for GA4.
 */
export function trackGA4AddShippingInfo(data: {
  currency?: string;
  value?: number; // Often the shipping cost itself, or total value if updated
  coupon?: string;
  shipping_tier?: string;
  items: ItemParameters[]; // Items in the cart/checkout
  [key: string]: any;
}): void {
  trackGA4Event("add_shipping_info", data);
}

/**
 * Tracks an add_payment_info event for GA4.
 */
export function trackGA4AddPaymentInfo(data: {
  currency?: string;
  value?: number; // Total value if updated
  coupon?: string;
  payment_type?: string;
  items: ItemParameters[]; // Items in the cart/checkout
  [key: string]: any;
}): void {
  trackGA4Event("add_payment_info", data);
}

/**
 * Tracks a purchase event for GA4.
 */
export function trackGA4Purchase(data: {
  transaction_id: string; // Unique ID for the transaction
  affiliation?: string;
  value: number; // Total revenue from the transaction (including tax and shipping)
  tax?: number;
  shipping?: number;
  currency: string;
  coupon?: string;
  items: ItemParameters[];
  [key: string]: any;
}): void {
  trackGA4Event("purchase", data);
}

/**
 * Tracks a refund event for GA4.
 */
export function trackGA4Refund(data: {
  transaction_id: string; // ID of the original transaction being refunded
  affiliation?: string;
  value?: number; // Total refund amount. If refunding specific items, GA4 calculates this from items array.
  currency?: string;
  items?: ItemParameters[]; // Recommended to include item details for item-level refund reporting
  [key: string]: any;
}): void {
  trackGA4Event("refund", data);
}

/**
 * Tracks a search event for GA4.
 */
export function trackGA4Search(data: {
  search_term: string;
  [key: string]: any; // Allow other custom parameters like number_of_results
}): void {
  // GA4 search event does not use the 'ecommerce' object structure typically.
  // It's a direct event with parameters.
  const dataLayer = getGaDataLayer();
  dataLayer.push({
    event: "search",
    ...data, // Spread other parameters, including search_term
  });
}

/**
 * Tracks a generate_lead event for GA4 (Recommended Event).
 */
export function trackGA4GenerateLead(data?: {
  value?: number;
  currency?: string;
  [key: string]: any;
}): void {
  const dataLayer = getGaDataLayer();
  dataLayer.push({
    event: "generate_lead",
    ...(data || {}),
  });
}

/**
 * Tracks a sign_up event for GA4 (Recommended Event).
 */
export function trackGA4SignUp(data: {
  method?: string; // e.g., "Google", "Email", "Facebook"
  [key: string]: any;
}): void {
  const dataLayer = getGaDataLayer();
  dataLayer.push({
    event: "sign_up",
    method: data.method,
    ...data,
  });
}

/**
 * Tracks a login event for GA4 (Recommended Event).
 */
export function trackGA4Login(data: {
  method?: string;
  [key: string]: any;
}): void {
  const dataLayer = getGaDataLayer();
  dataLayer.push({
    event: "login",
    method: data.method,
    ...data,
  });
}

// It's good practice to also offer a generic page_view for GA4 if not automatically handled by config
/**
 * Tracks a page_view event for GA4.
 * While gtag.js config usually handles initial page_view, this can be used for SPAs
 * or when needing to send additional parameters with page_view.
 */
export function trackGA4PageView(data?: {
  page_title?: string;
  page_location?: string; // Full URL
  page_path?: string; // Path part of the URL
  [key: string]: any;
}): void {
  const dataLayer = getGaDataLayer();
  dataLayer.push({
    event: "page_view",
    ...(data || {}),
  });
}
