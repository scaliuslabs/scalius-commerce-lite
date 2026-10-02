// Customers & marketing: consent per customer and channel (state machine,
// audit log by trigger, `customer.consent_changed`), the newsletter, account,
// staff/plugin and checkout surfaces, signed confirm/unsubscribe links, the
// double opt-in e-mail and the marketing send permission. Tags and segments
// live in the customers module (`customer-tags.ts`, `customer-segments.ts`).
export * from "./consent";
export * from "./flows";
export * from "./links";
export * from "./messages";
