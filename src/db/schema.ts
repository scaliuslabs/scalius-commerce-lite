// src/db/schema.ts
// ⚠️ LEGACY SHIM — This file is intentionally kept as a re-export barrel.
// All schema definitions have been split into domain-specific files under src/db/schema/.
// Do NOT add new code here. Instead, edit the appropriate domain file:
//   auth       → src/db/schema/auth.ts
//   rbac       → src/db/schema/rbac.ts
//   products   → src/db/schema/products.ts
//   customers  → src/db/schema/customers.ts
//   orders     → src/db/schema/orders.ts
//   inventory  → src/db/schema/inventory.ts
//   delivery   → src/db/schema/delivery.ts
//   marketing  → src/db/schema/marketing.ts
//   content    → src/db/schema/content.ts
//   system     → src/db/schema/system.ts
//   enums      → src/db/schema/enums.ts
export * from "./schema/index";
