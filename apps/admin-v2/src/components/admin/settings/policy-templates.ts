/**
 * Starting text for Settings -> Policies "Create from template": a draft page
 * the merchant reads and edits before publishing. Written for a Bangladeshi
 * online shop (cash on delivery, bKash/Nagad, courier delivery). English only;
 * the merchant rewrites it in their own words and language.
 */

export type PolicyKind = "refund" | "privacy" | "terms" | "shipping" | "contact";

export interface PolicyStore {
  companyName: string;
  email: string;
  phone: string;
  addressLine1: string;
  city: string;
}

const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function contactLines(store: PolicyStore): string {
  const lines = [
    store.phone && `Phone: ${escape(store.phone)}`,
    store.email && `Email: ${escape(store.email)}`,
    [store.addressLine1, store.city].filter(Boolean).length > 0 &&
      `Address: ${escape([store.addressLine1, store.city].filter(Boolean).join(", "))}`,
  ].filter(Boolean);
  return lines.length > 0 ? `<p>${lines.join("<br>")}</p>` : "<p>[Add your phone number and email]</p>";
}

const TEMPLATES: Record<PolicyKind, { title: string; slug: string; body: (name: string, store: PolicyStore) => string }> = {
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
    body: (name, store) => `
<p>${name} delivers across Bangladesh through trusted courier partners.</p>
<h2>Delivery time</h2>
<p>Inside Dhaka: usually 1 to 2 days. Outside Dhaka: usually 2 to 5 days. Delivery can take longer during Eid, public holidays, bad weather or strikes.</p>
<h2>Delivery charge</h2>
<p>The delivery charge for your area is shown at checkout before you place the order.</p>
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
<p>Questions about an order, a product or a return? The ${name} team is happy to help.</p>
${contactLines(store)}
<p>We reply to calls and messages from 10 am to 8 pm, Saturday to Thursday. Please have your order number ready.</p>`,
  },
};

/** A draft page for one policy: title, page address and starting text. */
export function policyTemplate(kind: PolicyKind, store: PolicyStore) {
  const template = TEMPLATES[kind];
  const name = escape(store.companyName.trim() || "our store");
  return { title: template.title, slug: template.slug, content: template.body(name, store).trim() };
}
