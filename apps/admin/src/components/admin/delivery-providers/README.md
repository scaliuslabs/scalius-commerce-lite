# Delivery Providers Admin UI

Settings page for configuring delivery provider integrations (Pathao, Steadfast). Accessed at `/admin/settings/delivery-providers`.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports: `DeliveryProvidersContainer` (also aliased as `DeliveryProviderSettings`), plus `DeliveryProviderRecord` and `DeliveryProviderType` types |
| `DeliveryProvidersContainer.tsx` | Root component. Manages all state: provider list, form data, editing/creating/testing/deleting flags. Contains API helpers (`apiSaveProvider`, `apiDeleteProvider`, `apiTestProvider`, `apiTestCredentials`). Generates webhook URLs and secrets. |
| `ProviderListSidebar.tsx` | Left panel: lists configured providers with active/inactive badges and provider type badges. "Add" button. Bottom section shows supported provider types with descriptions. |
| `ProviderDetailPanel.tsx` | Right panel (2/3 width): shows provider details, credential forms, config forms, webhook configuration, and integration guide. Switches between view/edit mode. Delete confirmation via `AlertDialog`. |
| `ProviderIcon.tsx` | `ProviderIcon` component, `PROVIDER_VISUAL` config map (icon, colors, description per type), `PROVIDER_TYPES` array, `DeliveryProviderRecord` interface |

## Astro Page

`apps/admin/src/pages/admin/settings/delivery-providers/index.astro`

Server-side: loads providers via `getDeliveryProvidersData()` loader. Passes `providers` array and `apiBaseUrl` as props.

Hydration: `client:idle`

## Layout

3-column grid (`md:grid-cols-3`):
- Column 1: `ProviderListSidebar` -- provider list + supported types card
- Columns 2-3: `ProviderDetailPanel` -- details/form or empty state

## State Machine

The container manages these boolean flags:
- `isEditing` -- form is in edit mode
- `isCreating` -- creating a new provider (vs editing existing)
- `isTesting` -- testing a saved provider's connection
- `isSaving` -- save operation in progress
- `isDeleting` -- delete operation in progress
- `isTestingCredentials` -- testing unsaved credentials
- `copiedWebhookUrl` / `copiedSecret` -- clipboard feedback states

## API Interactions

| Action | Method | Endpoint | Notes |
|--------|--------|----------|-------|
| List | GET | `/api/v1/admin/settings/delivery-providers` | Initial load via SSR loader |
| Save (create) | POST | `/api/v1/admin/settings/delivery-providers` | `id` is empty string |
| Save (update) | PUT | `/api/v1/admin/settings/delivery-providers` | `id` is set |
| Delete | DELETE | `/api/v1/admin/settings/delivery-providers/{id}` | |
| Test saved | POST | `/api/v1/admin/settings/delivery-providers/{id}` | Tests existing provider |
| Test unsaved | POST | `/api/v1/admin/settings/delivery-providers/create-test` | Ephemeral test with raw credentials |

Response parsing: all API helpers unwrap `json.data` if present and is a non-array object, otherwise use raw `json`.

## Credential Handling

- Credentials stored as JSON string in state (`formData.credentials`)
- `parseJSON()` helper used to extract `creds` and `conf` objects for form binding
- `handleCredentialChange()` and `handleConfigChange()` parse, mutate, re-stringify
- Type change resets credentials and config to `DEFAULT_CREDENTIALS[type]` / `DEFAULT_CONFIG[type]`
- New provider ID generated via `crypto.randomUUID()`

### Default Credentials

**Pathao**: `baseUrl` (default `https://api-hermes.pathao.com`), `clientId`, `clientSecret`, `username`, `password`, `webhookSecret`

**Steadfast**: `baseUrl` (default `https://portal.steadfast.com.bd/api/v1`), `apiKey`, `secretKey`, `webhookSecret`

### Default Config

**Pathao**: `storeId`, `defaultDeliveryType` (48=regular/12=express), `defaultItemType` (1=document/2=parcel), `defaultItemWeight` (0.5 KG)

**Steadfast**: `defaultCodAmount` (0)

## Webhook Configuration

Each provider form includes:
- **Webhook URL** (read-only): computed as `{apiBaseUrl}/api/v1/webhooks/{providerType}`. The base URL logic: `apiBaseUrl` prop, or `window.location.origin` with `dashboard.` replaced by `api.` and `:4321` replaced by `:8787`.
- **Webhook Secret**: stored in `credentials.webhookSecret`. "Generate" button creates a 32-byte random hex string. "Roll" regenerates (invalidates old). "Copy" button with clipboard feedback.
- **Setup Instructions**: blue info card with provider-specific instructions for Pathao (Merchant Dashboard > Settings > Webhook) or Steadfast (Dashboard > Settings > Webhook).

## Integration Guide

Collapsible accordion at the bottom of the detail panel. Provider-specific documentation:
- **Pathao**: credential sourcing, store ID configuration, location mapping requirement (links to delivery locations page), common city IDs
- **Steadfast**: credential generation, base URL alternatives (`portal.steadfast.com.bd` vs `portal.packzy.com`), address handling

## Visual System

`PROVIDER_VISUAL` in `ProviderIcon.tsx`:
- **Pathao**: `Truck` icon, orange color scheme (`bg-orange-100`, `text-orange-600`), "Ride-sharing & delivery platform"
- **Steadfast**: `Package` icon, blue color scheme (`bg-blue-100`, `text-blue-600`), "Courier & logistics service"

Icon sizes: `sm` (14px), `md` (20px), `lg` (28px)

## Known Gaps

- No delivery locations Astro page exists -- the `DeliveryLocationsContainer` component is referenced in integration guide links (`/admin/settings/delivery-locations`) but that page is not implemented as a standalone route
- Credential fields use HTML `type="password"` but the API returns masked values (`"xxxxxxxxxxxx"`) -- the API route's `unmaskedCredentials()` function handles preserving real credentials when masked values are sent back
- No validation that the credential fields are non-empty before save (only checks `formData.name`)
- Config fields are not validated (e.g. storeId could be empty for Pathao)
