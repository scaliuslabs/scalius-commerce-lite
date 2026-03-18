# Admin Settings Components

Settings UI split across three tab-based pages: General Settings, Checkout Settings, and Theme Settings.

## Files

| File | Description |
|------|-------------|
| `GeneralSettingsPage.tsx` | Top-level tabbed container for general settings. 8 lazy-loaded tabs: Header, Footer, SEO, Storefront, Email, Currency, Auth & Access, Security |
| `CheckoutSettingsPage.tsx` | Top-level tabbed container for checkout settings. 5 lazy-loaded tabs: Checkout Flow, Payment Gateways, Languages, Shipping Methods, Delivery Locations |
| `ThemeSettingsPage.tsx` | Storefront theme color editor. 17 semantic color tokens with hex input + native color picker. 5 predefined palettes (Zinc, Ocean Blue, Eco Emerald, Rose Blush, Midnight Dark). Live preview panel with sticky sidebar showing product card, buttons, alert mockups |
| `CurrencySettingsBuilder.tsx` | Currency selector (43 currencies), symbol override, USD exchange rate input. Fetches/saves via `/admin/settings/currency` |
| `AuthSettingsBuilder.tsx` | Account verification method selector (email/phone/both/sms_otp). Conditional WhatsApp Cloud API config (access token, phone number ID, template name). Masks configured tokens |
| `CheckoutFlowSettings.tsx` | Guest checkout toggle, checkout mode selector (all/guest_cod_only/gateways_only), partial payment toggle + amount input. Reads/writes via `/admin/settings/auth` endpoint |
| `PaymentMethodSettings.tsx` | Toggle Stripe/SSLCommerz/COD with gateway configuration status badges. Default method selector. Shows "No Credentials" warning for unconfigured gateways |
| `PaymentGatewaysManager.tsx` | Accordion-based gateway manager with lazy credential loading. 2x2 grid layout. Inline Stripe + SSLCommerz forms, imported Polar form. Gateway preferences card with default method selector. Live/Test/Sandbox mode badges |
| `payment-gateway-utils.tsx` | Shared types, constants (MASKED value), and reusable sub-components (PasswordInput, LiveWarning, SaveBtn, SandboxToggle, ExtLink) for payment gateway forms |
| `StripeSettingsForm.tsx` | (inline in PaymentGatewaysManager) Secret key, publishable key, webhook secret fields |
| `SSLCommerzSettingsForm.tsx` | (inline in PaymentGatewaysManager) Store ID, store password, sandbox toggle |
| `PolarSettingsForm.tsx` | Polar access token, webhook secret, product ID, sandbox toggle. Includes PolarSetupGuide dialog |
| `EmailSettingsForm.tsx` | Resend API key (masked) + sender email. Lazy-loaded from GeneralSettingsPage |
| `FirebaseSettingsForm.tsx` | (loaded via integrations tab) Firebase service account JSON + public config |

## Lazy Loading Pattern

Both `GeneralSettingsPage` and `CheckoutSettingsPage` use a "mount-on-first-visit" pattern:
1. Track `mountedTabs` Set in state
2. On tab change, add tab value to Set
3. Only render tab content when it exists in the Set
4. Each tab content is wrapped in `React.lazy()` + `<Suspense>` with a spinner fallback

This prevents loading all tab dependencies upfront and avoids re-mounting components when switching between tabs.

## API Envelope Handling

All components handle both proxy-unwrapped and raw API envelope formats:
```typescript
const data = json.data && typeof json.data === "object" && !Array.isArray(json.data) ? json.data : json;
```
This pattern appears in every `fetch` response handler because dev mode (Vite proxy) bypasses the admin proxy that normally unwraps the `{ success, data }` envelope.

## API Endpoints Used

| Component | GET | POST |
|-----------|-----|------|
| CurrencySettingsBuilder | `/admin/settings/currency` | `/admin/settings/currency` |
| AuthSettingsBuilder | `/admin/settings/auth` | `/admin/settings/auth` |
| CheckoutFlowSettings | `/admin/settings/auth` | `/admin/settings/auth` |
| ThemeSettingsPage | `/admin/settings/theme` | `/admin/settings/theme` |
| PaymentMethodSettings | `/admin/settings/payment-methods` | `/admin/settings/payment-methods` |
| PaymentGatewaysManager | `/admin/settings/payment-methods`, `/admin/settings/{gw}` | `/admin/settings/payment-methods`, `/admin/settings/{gw}` |

## Dependencies

- shadcn/ui components (Card, Tabs, Input, Select, Switch, Button, Badge, Alert, Accordion, Dialog)
- `sonner` for toast notifications
- `lucide-react` for icons
- `@scalius/shared/utils` -- `cn()` classname utility

## Known Gaps

- `CheckoutFlowSettings` and `AuthSettingsBuilder` both read/write the same `/admin/settings/auth` endpoint but manage different subsets of the fields. Saving in one does not refresh the other.
- `PaymentMethodSettings.tsx` exists as a standalone component but the `CheckoutSettingsPage` uses `PaymentGatewaysManager` instead -- `PaymentMethodSettings` is not mounted in any page.
- Polar is included in `PaymentGatewaysManager` but not in `PaymentMethodSettings` (which only knows about stripe/sslcommerz/cod).
