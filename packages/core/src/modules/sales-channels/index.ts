// Sales channels domain (docs/MARKETS-DESIGN.md D6): the channels a store
// publishes products to, the locations each sells from, publishing and
// unpublishing products, and the channel a staff order sells from. Buyer
// reads fold the publication and sellable-stock SQL from the products domain.
export * from "./sales-channels.service";
