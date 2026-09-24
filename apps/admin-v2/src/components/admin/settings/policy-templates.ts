/**
 * Starting text for Settings -> Policies "Create from template": a draft page
 * the merchant reads and edits before publishing. Written for a Bangladeshi
 * online shop (cash on delivery, bKash/Nagad, courier delivery). English only;
 * the merchant rewrites it in their own words and language. The store's name
 * and contact details, and for the shipping policy its saved shipping zones
 * and charges, fill the text so it matches what checkout does.
 */
import type { DeliveryZones } from "./DeliveryZones";

export type PolicyKind = "refund" | "privacy" | "terms" | "shipping" | "contact";

export interface PolicyStore {
  companyName: string;
  email: string;
  phone: string;
  addressLine1: string;
  city: string;
  /** The Store URL; its host names an unnamed store. */
  storefrontUrl: string;
}

export interface PolicyShipping {
  zones: DeliveryZones;
  currencySymbol: string;
}

type Rate = DeliveryZones["everywhereElse"]["rates"][number];

const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The business name, else the Store URL's host; mid-sentence "our store" when neither is set. */
function storeName(store: PolicyStore): string {
  const name = store.companyName.trim();
  if (name) return name;
  try {
    return new URL(store.storefrontUrl).host || "our store";
  } catch {
    return "our store";
  }
}

/** ৳60, ৳1,500.50: lakh grouping, whole amounts without decimals. */
function money(amount: number, symbol: string): string {
  const digits = Number.isInteger(amount) ? 0 : 2;
  return `${symbol}${new Intl.NumberFormat("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: 2 }).format(amount)}`;
}

function listPlaces(names: readonly string[]): string {
  const shown = names.slice(0, 5).map(escape).join(", ");
  return names.length > 5 ? `${shown} and ${names.length - 5} more` : shown;
}

/** "Standard ৳60, free on orders of ৳3,000 or more. Delivery in 1–2 days." */
function describeRate(rate: Rate, symbol: string, withName: boolean): string {
  const charge = [
    rate.fee === 0 ? (withName ? "free" : "Free") : money(rate.fee, symbol),
    rate.freeOver !== null && rate.fee > 0 ? `, free on orders of ${money(rate.freeOver, symbol)} or more` : "",
  ].join("");
  const note = rate.description?.trim() ?? "";
  return `${withName ? `${escape(rate.name)} ` : ""}${charge}.${note ? ` ${escape(/[.!?]$/.test(note) ? note : `${note}.`)}` : ""}`;
}

/** Where the store delivers, what each place pays and how long it takes, from the saved zones. */
function deliverySections(shipping: PolicyShipping | null): string {
  const holidays = "<p>The charge for your address is shown at checkout before you place the order. Delivery can take longer during Eid, public holidays, bad weather or strikes.</p>";
  const live = (rates: readonly Rate[], kind: Rate["kind"]) => rates.filter((rate) => rate.isActive && rate.kind === kind);
  const zones = (shipping?.zones.zones ?? [])
    .map((zone) => ({ zone, rates: live(zone.rates, "delivery") }))
    .filter(({ zone, rates }) => zone.locations.length > 0 && rates.length > 0);
  const elsewhere = live(shipping?.zones.everywhereElse.rates ?? [], "delivery");
  const pickups = live(shipping?.zones.everywhereElse.rates ?? [], "pickup");
  if (!shipping || (zones.length === 0 && elsewhere.length === 0 && pickups.length === 0)) {
    return `<h2>Delivery charges and times</h2>\n${holidays}`;
  }
  const symbol = shipping.currencySymbol;
  const rateText = (rates: readonly Rate[], title: string) =>
    rates.map((rate) => describeRate(rate, symbol, rates.length > 1 || rate.name.trim() !== title)).join(" ");
  const items = [
    ...zones.map(({ zone, rates }) =>
      `<li><strong>${escape(zone.name)}</strong> (${listPlaces(zone.locations.map((place) => place.name))}): ${rateText(rates, zone.name)}</li>`),
    ...(elsewhere.length > 0
      ? [`<li><strong>${zones.length > 0 ? "Everywhere else" : "Everywhere we deliver"}</strong>: ${rateText(elsewhere, "")}</li>`]
      : []),
  ];
  const delivery = items.length === 0 ? [] : [
    `<h2>Delivery charges and times</h2>\n<ul>\n${items.join("\n")}\n</ul>`,
    ...(zones.length > 0 && elsewhere.length === 0 ? ["<p>We don't deliver outside these areas yet.</p>"] : []),
    holidays,
  ];
  const pickup = pickups.length === 0 ? [] : [
    "<h2>Pickup</h2>",
    ...pickups.map((rate) =>
      `<p>You can collect your order from ${escape(rate.pickupAddress ?? "")}${rate.pickupHours ? ` (${escape(rate.pickupHours)})` : ""}. ${
        rate.fee === 0 ? "Pickup is free." : `Pickup costs ${money(rate.fee, symbol)}.`}</p>`),
  ];
  return [...delivery, ...pickup].join("\n");
}

function contactLines(store: PolicyStore): string {
  const lines = [
    store.phone && `Phone: ${escape(store.phone)}`,
    store.email && `Email: ${escape(store.email)}`,
    [store.addressLine1, store.city].filter(Boolean).length > 0 &&
      `Address: ${escape([store.addressLine1, store.city].filter(Boolean).join(", "))}`,
  ].filter(Boolean);
  return lines.length > 0 ? `<p>${lines.join("<br>")}</p>` : "<p>[Add your phone number and email]</p>";
}

const TEMPLATES: Record<PolicyKind, {
  title: string;
  slug: string;
  body: (name: string, store: PolicyStore, shipping: PolicyShipping | null) => string;
}> = {
  refund: {
    title: "Return and refund policy",
    slug: "refund-policy",
    body: (name, store) => `
<p>We want you to be happy with every order from ${name}. If something is wrong, tell us and we will make it right.</p>
<h2>Returns</h2>
<p>You can return an item within 7 days of delivery if it is unused, unwashed and in its original packaging with the tags on. Items that are damaged, faulty or not what you ordered can always be returned.</p>
<p>These items cannot be returned unless they arrive damaged or wrong: undergarments, cosmetics and personal care items that have been opened, and items marked as final sale.</p>
<h2>How to return</h2>
<p>Contact us with your order number and a photo of the item. We will arrange a courier pickup or tell you where to send it. Please check the parcel in front of the delivery person and report any damage the same day.</p>
<h2>Refunds</h2>
<p>After we receive and check the item, we refund you within 7 working days. Orders paid online (bKash, Nagad or card) are refunded to the same account. Cash on delivery orders are refunded by bKash or Nagad to a number you give us. The delivery charge is refunded only when the item was damaged, faulty or wrong.</p>
<h2>Exchanges</h2>
<p>If you need a different size or colour, we exchange the item when it is in stock. You pay the delivery charge for exchanges unless the mistake was ours.</p>
<h2>Contact</h2>
${contactLines(store)}`,
  },
  privacy: {
    title: "Privacy policy",
    slug: "privacy-policy",
    body: (name, store) => `
<p>This policy explains what information ${name} collects when you shop with us and how we use it.</p>
<h2>What we collect</h2>
<p>Your name, phone number, delivery address and, if you give it, your email address. We also keep your order history and payment status. When you pay online, the payment company (such as bKash, Nagad or SSLCommerz) handles your payment details; we do not see or store your PIN or card number.</p>
<h2>How we use it</h2>
<p>To deliver your order, call or message you about it, handle returns and refunds, and prevent fraud. We share your name, phone number and address with the courier that delivers your parcel. If you agree, we may send you offers by SMS or email; you can stop them at any time.</p>
<h2>How long we keep it</h2>
<p>We keep order records for as long as the law requires for accounts and taxes, and delete information we no longer need.</p>
<h2>Your choices</h2>
<p>You can ask us to show, correct or delete the information we hold about you by contacting us.</p>
<h2>Contact</h2>
${contactLines(store)}`,
  },
  terms: {
    title: "Terms of service",
    slug: "terms-of-service",
    body: (name, store) => `
<p>These terms apply when you browse or buy from ${name}. By placing an order you agree to them.</p>
<h2>Orders</h2>
<p>We may call you to confirm your order before we send it. We can cancel an order if we cannot reach you, if the item is out of stock, or if the price or details were shown wrongly; if you already paid, we refund you in full.</p>
<h2>Prices and payment</h2>
<p>Prices are in Bangladeshi Taka (৳). You can pay cash on delivery or online where offered. For some orders we may ask for an advance payment, for example the delivery charge, before we send them.</p>
<h2>Delivery</h2>
<p>Delivery times and charges are explained in our shipping policy. Please check your parcel when it arrives.</p>
<h2>Returns</h2>
<p>Returns and refunds follow our return and refund policy.</p>
<h2>Using our website</h2>
<p>Product photos and descriptions are as accurate as we can make them; colours can look slightly different on screens. Do not misuse the website, place fake orders or copy our content.</p>
<h2>Changes</h2>
<p>We may update these terms. The version on this page when you place an order applies to that order.</p>
<h2>Contact</h2>
${contactLines(store)}`,
  },
  shipping: {
    title: "Shipping policy",
    slug: "shipping-policy",
    body: (name, store, shipping) => `
<p>Here is where ${name} delivers, what delivery costs and how long it takes.</p>
${deliverySections(shipping)}
<h2>Cash on delivery</h2>
<p>Pay the delivery person when your parcel arrives. Please keep the exact amount ready. You may check the parcel before you pay.</p>
<h2>Tracking</h2>
<p>After your order is sent, we share the courier's tracking number with you by SMS.</p>
<h2>Failed delivery</h2>
<p>If the courier cannot reach you or the parcel is refused without a reason, we may ask for the delivery charge in advance on your next order.</p>
<h2>Contact</h2>
${contactLines(store)}`,
  },
  contact: {
    title: "Contact information",
    slug: "contact",
    body: (name, store) => `
<p>Questions about an order, a product or a return? Contact ${name} and we're happy to help.</p>
${contactLines(store)}
<p>We reply to calls and messages from 10 am to 8 pm, Saturday to Thursday. Please have your order number ready.</p>`,
  },
};

/** A draft page for one policy: title, page address and starting text. */
export function policyTemplate(kind: PolicyKind, store: PolicyStore, shipping: PolicyShipping | null = null) {
  const template = TEMPLATES[kind];
  return { title: template.title, slug: template.slug, content: template.body(escape(storeName(store)), store, shipping).trim() };
}
