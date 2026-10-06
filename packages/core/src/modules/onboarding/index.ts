// Onboarding domain: the store setup step after the first admin exists
// (country, currency, language, time zone, units). It composes settings,
// platform and markets writes into one guarded batch, so it sits above them.
export * from "./store-setup.service";
