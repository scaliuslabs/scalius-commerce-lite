// The account's pages for the private pages' rendered gate (test-support/private-pages.properties.browser.mjs): each
// page of `PRIVATE_PAGE_ROUTES.account` drawn as a signed-in buyer gets it, from these answers of the store's API.
// Each holds what a buyer reads there: a thread's own message, the store's, a status line, a photo that does not
// load and a product card; a profile with its addresses and a saved card; reviews to write and one written with the
// store's reply; a gift card with its history; downloads; warranties with a claim; a guest's claim thread.

/** The session cookie a signed-in buyer's request carries (its value is the fixture's). */
export const GALLERY_ACCOUNT_SESSION = "cs_tok=gallery-account-session";
export const GALLERY_THREAD_ID = "cnv_gallerythread1";
export const GALLERY_CLAIM = { orderId: "ord_gallery_1", claimId: "wcl_gallery12345678" } as const;

const SECONDS = Date.parse("2026-09-12T08:00:00.000Z") / 1000;
const IMAGE = "/placeholder-product.svg";
const CUSTOMER = { id: "cus_gallery", name: "Rahim Uddin", email: "rahim@example.test", phone: "+8801712345678", phoneVerified: true, whatsapp: null };

const THREAD_MESSAGES = [
  { id: "msg_g1", seq: 1, from: "buyer", kind: "message", body: "When will my order arrive? I paid for express delivery.", createdAt: SECONDS, attachments: [], eventKind: null, eventData: null },
  { id: "msg_g2", seq: 2, from: "system", kind: "event", body: null, createdAt: SECONDS + 60, attachments: [], eventKind: "support_request_status", eventData: { type: "return", toStatus: "under_review" } },
  // A photo the browser cannot load: its fallback words show.
  { id: "msg_g3", seq: 3, from: "store", kind: "message", body: "It leaves our warehouse tomorrow morning.", createdAt: SECONDS + 120, attachments: [{ id: "att_gallerymissing1", width: 100, height: 100 }], eventKind: null, eventData: null },
  { id: "msg_g4", seq: 4, from: "store", kind: "message", body: "This one is in stock too", createdAt: SECONDS + 180, attachments: [], eventKind: "product_reply", eventData: null,
    products: [{ title: "Linen panjabi", variantLabel: "Large", pdpUrl: "/products/linen", imageUrl: IMAGE, price: { amount: 2200, currency: "BDT" }, status: "available" }] },
  // The buyer's own message with a photo that does not load: its muted fallback words stand on the buyer's message.
  { id: "msg_g5", seq: 5, from: "buyer", kind: "message", body: "Thank you, I will wait.", createdAt: SECONDS + 240, attachments: [{ id: "att_gallerymissing2", width: 100, height: 100 }], eventKind: null, eventData: null },
];

const thread = (id: string, subjectType: string) => ({
  id, subjectType, subject: subjectType === "warranty_claim" ? "Screen flickers" : null, topic: null, orderNumber: 1042, orderId: GALLERY_CLAIM.orderId,
  status: "pending", lastSeq: 5, readSeq: 2, hasMore: false, messages: THREAD_MESSAGES,
});

const ANSWERS: Record<string, unknown> = {
  "/customer-auth/account-summary": {
    orders: 3, spent: [{ currencyCode: "BDT", orders: 3, amount: 5400, amountMinor: 540000 }], openConversations: 1,
    unreadInbox: 1, reviewsToWrite: 1, reviewsWritten: 1, downloads: 1, giftCards: 1, activeWarranties: 1,
  },
  "/customer-auth/me": { authenticated: true, customer: CUSTOMER },
  "/customer-auth/marketing": { channels: [{ channel: "email", status: "subscribed", available: true }, { channel: "sms", status: "not_subscribed", available: true }] },
  "/customer-auth/payment-methods": { paymentMethods: [{ id: "cpm_gallery1", brand: "visa", last4: "4242", expiryMonth: 8, expiryYear: 2099, label: null, savedFor: "Subscribe and save", createdAt: "2026-09-12T08:00:00.000Z" }] },
  "/customer-auth/addresses": { addresses: [
    { id: "adr_gallery1", countryCode: "BD", line1: "House 12, Road 5", line2: null, city: "dhaka", zone: "mirpur", area: null, cityName: "Dhaka", zoneName: "Mirpur", areaName: null, dependentLocality: null, locality: null, adminArea: null, postalCode: null, isDefault: true, isDefaultBilling: false, name: "Rahim Uddin", phone: null, company: null },
    { id: "adr_gallery2", countryCode: "BD", line1: "Flat 4B, Lake Road", line2: null, city: "dhaka", zone: "gulshan", area: null, cityName: "Dhaka", zoneName: "Gulshan", areaName: null, dependentLocality: null, locality: null, adminArea: null, postalCode: null, isDefault: false, isDefaultBilling: true, name: "Rahim Uddin", phone: null, company: "Acme" },
  ] },
  "/locations/cities": [{ id: "dhaka", name: "Dhaka" }],
  "/locations/zones": [{ id: "mirpur", name: "Mirpur" }, { id: "gulshan", name: "Gulshan" }],
  "/locations/areas": [{ id: "mirpur-1", name: "Mirpur 1" }],
  "/customer-auth/conversations": {
    items: [
      { id: GALLERY_THREAD_ID, subjectType: "order", subject: null, topic: null, orderNumber: 1042, orderId: GALLERY_CLAIM.orderId, status: "pending", unread: 1, lastMessageAt: SECONDS + 240 },
      { id: "cnv_gallerystore01", subjectType: "store", subject: "Delivery times", topic: { key: "delivery", label: "Delivery" }, orderNumber: null, orderId: null, status: "open", unread: 0, lastMessageAt: SECONDS - 86_400 },
    ],
    nextCursor: null, canStartStoreConversation: true, topics: [{ key: "delivery", label: "Delivery" }],
  },
  [`/customer-auth/conversations/${GALLERY_THREAD_ID}`]: { conversation: thread(GALLERY_THREAD_ID, "order") },
  [`/orders/receipt/${GALLERY_CLAIM.orderId}/warranty-claims/${GALLERY_CLAIM.claimId}`]: { conversation: thread("cnv_galleryclaim01", "warranty_claim") },
  "/customer-auth/reviews": {
    toReview: [{ orderId: GALLERY_CLAIM.orderId, orderNumber: 1042, orderItemId: "oi_gallery_2", productId: "prod_gallery_2", productName: "Cotton panjabi", productSlug: "cotton-panjabi", variantLabel: "Medium", imageUrl: IMAGE, fulfilledAt: "2026-09-14T08:00:00.000Z" }],
    reviews: [{
      id: "rev_gallery_1", orderId: GALLERY_CLAIM.orderId, orderItemId: "oi_gallery_1", productId: "prod_gallery_1", productName: "Silk saree", productSlug: "silk-saree", variantLabel: null,
      rating: 4, title: "Lovely colour", body: "The colour is exactly as pictured. Delivery was quick.", displayName: "Rahim U.", status: "published",
      reply: { body: "Thank you for your kind words!", repliedAt: "2026-09-16T08:00:00.000Z" }, createdAt: "2026-09-15T08:00:00.000Z", publishedAt: "2026-09-15T08:00:00.000Z", editedAt: null, version: 1, canEdit: true,
    }],
  },
  "/customer-auth/gift-cards": { giftCards: [{
    id: "gc_gallery1", last4: "7K2Q", currencyCode: "BDT", initialAmount: 1000, initialAmountMinor: 100000, balance: 500, balanceMinor: 50000,
    expiresAt: null, expired: false, createdAt: "2026-09-12T08:00:00.000Z", status: "active", source: "purchase",
    transactions: [
      { id: "gct_gallery1", kind: "issue", amount: 1000, amountMinor: 100000, balanceAfter: 1000, balanceAfterMinor: 100000, orderId: null, orderNumber: null, createdAt: "2026-09-12T08:00:00.000Z" },
      { id: "gct_gallery2", kind: "redeem", amount: -500, amountMinor: -50000, balanceAfter: 500, balanceAfterMinor: 50000, orderId: GALLERY_CLAIM.orderId, orderNumber: "1042", createdAt: "2026-09-13T08:00:00.000Z" },
    ],
  }] },
  "/customer-auth/downloads": { lines: [{
    orderId: GALLERY_CLAIM.orderId, orderNumber: 1042, orderItemId: "oi_gallery_3", productName: "Pattern book", variantLabel: null, deliveredAt: "2026-09-12T08:00:00.000Z",
    files: [
      { entitlementId: "ent_gallery1", displayName: "Patterns (PDF)", downloadCount: 1, downloadLimit: 5, expiresAt: "2099-01-01T00:00:00.000Z", revoked: false, available: true, sizeBytes: 1_572_864 },
      { entitlementId: "ent_gallery2", displayName: "Old patterns", downloadCount: 5, downloadLimit: 5, expiresAt: null, revoked: false, available: true, sizeBytes: 2048 },
    ],
    licenceKeys: [{ keyId: "key_gallery1", last4: "7K2Q" }],
  }] },
  "/customer-auth/warranties": { items: [{
    warrantyId: "wty_gallery123456", policyName: "1 year official warranty", provider: "brand", durationValue: 1, durationUnit: "years", replacementDays: 7,
    terms: "Covers manufacturing faults. Not physical damage.", quantity: 1, startsAt: "2026-09-20T06:00:00.000Z", expiresAt: "2099-09-20T06:00:00.000Z",
    replacementUntil: "2026-09-27T06:00:00.000Z", voided: false, openClaimId: GALLERY_CLAIM.claimId, orderId: GALLERY_CLAIM.orderId, orderNumber: 1042,
    orderItemId: "oi_gallery_4", productId: "prod_gallery_4", productName: "Smart phone", variantLabel: "128 GB", imageUrl: IMAGE, state: "active",
    claim: { id: GALLERY_CLAIM.claimId, conversationId: "cnv_galleryclaim01", status: "in_progress", resolution: null },
  }] },
};

/** The store's answer to an account page's read (`path` after `/api/v1`), or undefined. */
export function galleryAccountAnswer(path: string): unknown {
  return Object.hasOwn(ANSWERS, path) ? ANSWERS[path] : undefined;
}
