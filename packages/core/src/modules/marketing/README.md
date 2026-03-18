# Marketing

Thin re-export layer. The `index.ts` re-exports everything from `../discounts`.

## Relationship to Discounts Module

This module exists for backward compatibility. The canonical discount logic lives in `packages/core/src/modules/discounts/`. The `marketing/index.ts` file re-exports from there:

```typescript
export * from "../discounts";
```

## Dead Code: `discounts.service.ts`

This file contains a standalone `getDiscounts()` function that duplicates the list functionality from `discounts/discounts.service.ts`. Key differences from the canonical version:

- Imports `db` as a module-level singleton (`import { db } from "@scalius/database/client"`) instead of accepting it as a parameter
- Does NOT join `discountProducts` or `discountCollections` -- returns hardcoded empty `{ buy: [], get: [] }` via `json_object()`
- Supports a `type` filter parameter that the canonical `DiscountService.list()` does not
- Uses raw SQL casting for timestamps instead of Drizzle's ORM-level handling

This file is NOT imported by anything. The `marketing/index.ts` re-exports from `../discounts`, not from `./discounts.service`. It should be deleted.

## Files

| File | Description |
|------|-------------|
| `index.ts` | Re-exports everything from `../discounts` |
| `discounts.service.ts` | **Dead code.** Duplicate list function, never imported. |

## Action Required

Delete `discounts.service.ts` -- it is dead code that duplicates and diverges from the canonical `DiscountService.list()`.
