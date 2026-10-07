// Translations domain (docs/MARKETS-DESIGN.md D9): the store's languages, the
// translation editor's reads and writes, and the SQL buyer-facing reads fold
// in to resolve a presence's translations. The one fallback chain and the
// list of translatable resources live in @scalius/shared/translations.
export * from "./store-languages.service";
export * from "./translations.service";
export * from "./fold";
export { TABLE_SOURCES, type PaymentMethodSource, type ResourceSource } from "./resources";
