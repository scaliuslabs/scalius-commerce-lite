# International Phone Numbers — Design Spec

**Date**: 2026-03-18
**Status**: Approved
**Scope**: Replace Bangladesh-only phone handling with full international support using `libphonenumber-js` + `react-phone-number-input`.

## Problem

Phone numbers are hardcoded for Bangladesh across 17+ files with 5 different regex patterns. Critical bug: admin-created customers store `01XXXXXXXXX` (local format), storefront auth stores `+8801XXXXXXXXX` (E.164) — admin customers can't log in via storefront because the lookup format doesn't match.

## Solution

### Core Principles
1. **Storage**: E.164 format everywhere (`+8801712345678`, `+14155552671`)
2. **Validation**: `libphonenumber-js` — validates against real country numbering plans
3. **UI**: `react-phone-number-input` — country flag dropdown, auto-formatting
4. **Settings**: Merchant configures allowed countries (default: all)

### Package Installations

- `libphonenumber-js` in `packages/shared` (lightweight, 150KB, tree-shakeable)
- `react-phone-number-input` in `apps/admin` and `apps/storefront` (uses libphonenumber-js internally)

### Layer 1: Shared Utilities (`packages/shared/src/customer-utils.ts`)

Replace all existing phone functions with:

```typescript
import { parsePhoneNumber, isValidPhoneNumber, type CountryCode } from "libphonenumber-js";

/**
 * Validate and format a phone number to E.164.
 * Returns the E.164 string or throws with a clear message.
 */
export function validateAndFormatPhone(
  input: string,
  allowedCountries?: string[],
): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Phone number is required");

  // Try parsing with no default country (requires + prefix or unambiguous input)
  if (!isValidPhoneNumber(trimmed)) {
    throw new Error("Invalid phone number");
  }

  const parsed = parsePhoneNumber(trimmed);
  if (!parsed) throw new Error("Could not parse phone number");

  // Check allowed countries
  if (allowedCountries && allowedCountries.length > 0 && parsed.country) {
    if (!allowedCountries.includes(parsed.country)) {
      throw new Error(`Phone numbers from ${parsed.country} are not accepted`);
    }
  }

  return parsed.format("E.164"); // e.g., "+8801712345678"
}

/**
 * Format E.164 phone for display (national format with country context).
 */
export function formatPhoneForDisplay(e164: string): string {
  try {
    const parsed = parsePhoneNumber(e164);
    return parsed ? parsed.formatInternational() : e164;
  } catch {
    return e164;
  }
}

/**
 * Zod schema for phone validation.
 * Replaces the old phoneNumberSchema.
 */
export const phoneNumberSchema = z
  .string()
  .min(7, "Phone number too short")
  .max(16, "Phone number too long")
  .transform((val) => validateAndFormatPhone(val));
```

Keep backward compatibility: export the same `phoneNumberSchema` name so existing imports don't break.

The old `standardizePhoneNumber()` and `normalizePhone()` functions should be removed. Any callers will be updated to use `validateAndFormatPhone()`.

### Layer 2: Core Services

**`customers.validation.ts`**: Already imports `phoneNumberSchema` from shared — the new implementation flows through automatically.

**`customer-auth.service.ts`**: Replace all `normalizePhone()` calls with `validateAndFormatPhone()`. The function now returns E.164 consistently. Update the inline regex `/^\+?[1-9]\d{1,14}$/` at line 178 to use `isValidPhoneNumber()` from libphonenumber-js.

**`customers.service.ts`**: No changes needed — already uses `phoneNumberSchema` via validation module.

### Layer 3: Settings — Allowed Countries

**New setting key**: `allowedCountries` in the `settings` key-value table.
- Value: JSON array of ISO 3166-1 alpha-2 country codes, e.g., `["BD","US","GB"]`
- Empty array `[]` = all countries allowed
- Default: `[]` (all countries)

**API**: Add to existing settings routes:
- `GET /admin/settings/site` — include `allowedCountries` in response
- `PUT /admin/settings/site` — accept `allowedCountries` field

**Storefront checkout config**: Include `allowedCountries` in `GET /checkout` response so the storefront phone input can filter countries.

### Layer 4: Admin UI

**`CustomerForm.tsx`**: Replace `<Input type="text">` phone field with:
```tsx
import PhoneInput from "react-phone-number-input";
import "react-phone-number-input/style.css";

<PhoneInput
  international
  defaultCountry="BD"
  countries={allowedCountries.length > 0 ? allowedCountries : undefined}
  value={field.value}
  onChange={field.onChange}
/>
```

**`order-form/CustomerInfoSection.tsx`**: Same replacement.

**Settings page**: Add an "Allowed Countries" multi-select in site settings. Use a searchable multi-select component with ISO country names.

### Layer 5: Storefront UI

**`AuthModal.tsx`**: Replace phone text input with `react-phone-number-input`. The allowed countries come from the checkout config API (already fetched during checkout).

**`cart.astro` / `cart/server.ts`**: Replace manual normalization (lines 31-36 in server.ts) with `validateAndFormatPhone()`. Remove the Bangladesh-only regex `/^01[3-9]\d{8}$/`. Remove hardcoded error message "Please enter a valid Bangladeshi phone number".

**`cart/client.ts`**: Update placeholder from `"01XXXXXXXXX"` to a neutral `"Phone number"`. The phone input component handles formatting.

### Layer 6: Data Migration

Existing phone numbers in local format (`01XXXXXXXXX`) need E.164 conversion. Since all existing data is Bangladesh:

```sql
-- Normalize existing customers table
UPDATE customers
SET phone = '+880' || SUBSTR(phone, 2)
WHERE phone LIKE '01%' AND LENGTH(phone) = 11;

-- Normalize existing orders table
UPDATE orders
SET customer_phone = '+880' || SUBSTR(customer_phone, 2)
WHERE customer_phone LIKE '01%' AND LENGTH(customer_phone) = 11;

-- Normalize abandoned checkouts
UPDATE abandoned_checkouts
SET customer_phone = '+880' || SUBSTR(customer_phone, 2)
WHERE customer_phone LIKE '01%' AND LENGTH(customer_phone) = 11;

-- Normalize customer history
UPDATE customer_history
SET phone = '+880' || SUBSTR(phone, 2)
WHERE phone LIKE '01%' AND LENGTH(phone) = 11;
```

This is a data migration (migration 0026), not a schema migration. No column changes needed.

### FTS5 Search

The `customers_fts` table indexes the `phone` column. After migration, all phones are E.164. Search works by prefix matching — searching `+880171` finds Bangladesh numbers, searching `+1415` finds US numbers. The FTS5 tokenizer handles the `+` prefix.

### Files Changed Summary

| File | Change |
|------|--------|
| `packages/shared/package.json` | Add `libphonenumber-js` dependency |
| `packages/shared/src/customer-utils.ts` | Replace all phone functions with libphonenumber-js |
| `packages/core/src/modules/customers/customer-auth.service.ts` | Replace normalizePhone() calls |
| `packages/core/src/modules/customers/customers.validation.ts` | Uses shared phoneNumberSchema (auto-updated) |
| `apps/admin/package.json` | Add `react-phone-number-input` dependency |
| `apps/admin/src/components/admin/CustomerForm.tsx` | Phone input component |
| `apps/admin/src/components/admin/order-form/CustomerInfoSection.tsx` | Phone input component |
| `apps/admin/src/pages/admin/settings/index.astro` (or settings component) | Allowed countries picker |
| `apps/storefront/package.json` | Add `react-phone-number-input` dependency |
| `apps/storefront/src/components/AuthModal.tsx` | Phone input component |
| `apps/storefront/src/lib/cart/server.ts` | Replace manual normalization |
| `apps/storefront/src/lib/cart/client.ts` | Update placeholders |
| `apps/api/src/routes/customer-auth.ts` | Replace inline regex |
| `apps/api/src/routes/checkout.ts` | Include allowedCountries in config |
| `packages/database/migrations/0026_normalize_phone_e164.sql` | Data migration |
| README files | Update customers and order-form READMEs |

### Success Criteria

1. All phone numbers stored as E.164 in database
2. Admin can create customers with any international phone number
3. Storefront customers can register/login with any international number
4. Merchant can configure allowed countries in settings
5. Phone input shows country flag dropdown
6. Admin-created customers CAN log in via storefront (format match)
7. `pnpm typecheck` passes with 0 errors
8. Existing Bangladesh phone data migrated to E.164
