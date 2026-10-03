// Order kernel: what every domain that changes an order shares, below the
// payments, delivery, notification and promotion domains that act on orders
// (modules/orders builds the order workflows on top of all of them):
// - the status state machine (./state-machine, browser-safe);
// - the three mutation locks: a shipment claim, a hosted-payment setup and a
//   refund in flight each keep every other writer off the order;
// - the immutable facts apps record on an order (`order_events`).
export * from "./browser";
export * from "./shipment-claim";
export * from "./payment-session-guard";
export * from "./refund-attempt-guard";
export * from "./app-facts";
