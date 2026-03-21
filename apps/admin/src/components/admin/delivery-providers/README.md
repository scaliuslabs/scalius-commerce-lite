# Delivery Providers Admin UI

Settings page for configuring delivery provider integrations (Pathao, Steadfast). Accessed at `/admin/settings/delivery-providers`.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports: `DeliveryProvidersContainer` (also aliased as `DeliveryProviderSettings`), plus `DeliveryProviderRecord` and `DeliveryProviderType` types |
| `DeliveryProvidersContainer.tsx` | Root component. Manages all state: provider list, form data, editing/creating/testing/deleting flags. Contains API helpers (`apiSaveProvider`, `apiDeleteProvider`, `apiTestProvider`, `apiTestCredentials`). Generates webhook URLs and secrets. |
| `ProviderListSidebar.tsx` | Left panel: lists configured providers with active/inactive badges and provider type badges. "Add" button. Bottom section shows supported provider types with descriptions. |
| `ProviderDetailPanel.tsx` | Right panel (2/3 width): provider details, credential forms, config forms, webhook configuration, and integration guide. Switches between view/edit mode. Delete confirmation via `AlertDialog`. |
| `ProviderIcon.tsx` | `ProviderIcon` component, `PROVIDER_VISUAL` config map (icon, colors, description per type), `PROVIDER_TYPES` array, `DeliveryProviderRecord` interface |

## Layout

3-column grid (`md:grid-cols-3`):
- Column 1: `ProviderListSidebar` -- provider list + supported types card
- Columns 2-3: `ProviderDetailPanel` -- details/form or empty state

## API Endpoints Used

| Action | Method | Endpoint |
|--------|--------|----------|
| List | GET | `/api/v1/admin/settings/delivery-providers` |
| Save (create) | POST | `/api/v1/admin/settings/delivery-providers` |
| Save (update) | PUT | `/api/v1/admin/settings/delivery-providers` |
| Delete | DELETE | `/api/v1/admin/settings/delivery-providers/{id}` |
| Test saved | POST | `/api/v1/admin/settings/delivery-providers/{id}` |
| Test unsaved | POST | `/api/v1/admin/settings/delivery-providers/create-test` |

## Credential Handling

- Credentials stored as JSON string in state (`formData.credentials`)
- `parseJSON()` helper extracts `creds` and `conf` objects for form binding
- Type change resets credentials and config to provider defaults
- New provider ID generated via `crypto.randomUUID()`
- Server-side: credentials are encrypted with AES-GCM if `CREDENTIAL_ENCRYPTION_KEY` is available. API responses mask sensitive fields with `"xxxxxxxxxxxx"`.

### Default Credentials

**Pathao**: `baseUrl` (default `https://api-hermes.pathao.com`), `clientId`, `clientSecret`, `username`, `password`, `webhookSecret`

**Steadfast**: `baseUrl` (default `https://portal.steadfast.com.bd/api/v1`), `apiKey`, `secretKey`, `webhookSecret`

### Default Config

**Pathao**: `storeId`, `defaultDeliveryType` (48=regular/12=express), `defaultItemType` (1=document/2=parcel), `defaultItemWeight` (0.5 KG)

**Steadfast**: `defaultCodAmount` (0)

## Webhook Configuration

Each provider form includes:
- **Webhook URL** (read-only): computed as `{apiBaseUrl}/api/v1/webhooks/{providerType}`
- **Webhook Secret**: stored in `credentials.webhookSecret`. "Generate" creates 32-byte random hex. "Roll" regenerates. "Copy" with clipboard feedback.
- **Setup Instructions**: provider-specific instructions for configuring webhooks

## Integration Guide

Collapsible accordion with provider-specific documentation:
- **Pathao**: credential sourcing, store ID configuration, location mapping
- **Steadfast**: credential generation, base URL alternatives, address handling

## Visual System

`PROVIDER_VISUAL` in `ProviderIcon.tsx`:
- **Pathao**: `Truck` icon, orange color scheme
- **Steadfast**: `Package` icon, blue color scheme

Icon sizes: `sm` (14px), `md` (20px), `lg` (28px)

## Known Gaps

- Credential fields use `type="password"` but the API returns masked values -- the API's `unmaskedCredentials()` preserves real credentials when masked values are sent back
- No validation that credential fields are non-empty before save (only checks `formData.name`)
- Config fields are not validated (e.g. storeId could be empty for Pathao)
