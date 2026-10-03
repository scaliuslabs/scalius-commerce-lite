// Markets domain (docs/MARKETS-DESIGN.md D4): market records with their
// countries and URL presences, the backup market's pricing (the store's
// price increment) and the active presence matrix buyers resolve against.
// The pure resolution and presence rules live in @scalius/shared/markets.
export * from "./pricing";
export * from "./matrix";
export * from "./markets.service";
export * from "./order-market";
