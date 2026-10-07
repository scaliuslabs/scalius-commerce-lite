// Settings domain: the store's shared settings documents (core/settings-store
// keeps every document; a domain that owns one declares it itself) and the
// services that read and write them. It depends on no other domain.
export * from "./browser";
export * from "./documents";
export * from "./settings.service";
export * from "./site-settings.service";
export * from "./store-name";
export * from "./customer-request-policy";
export * from "./business-settings.service";
export * from "./emi-settings.service";
export * from "./store-money";
export * from "./phone-country-policy";
export * from "./staff-setup-guide";
export * from "./staff-shortcuts";
