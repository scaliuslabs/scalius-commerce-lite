// src/shared/currency.ts
// This file is a thin shim re-exporting the canonical currency logic from the settings module.
// This maintains backward compatibility for consumers without duplicating business logic.

export {
  type CurrencyConfig,
  getCurrencyConfig,
} from "@/modules/settings/settings.service";
