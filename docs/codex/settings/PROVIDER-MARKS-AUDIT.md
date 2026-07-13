# Provider Marks and Integration Identity

Last reviewed: 2026-07-14

This document owns the visual-identity decision for third-party providers in
merchant settings. It covers payment, delivery, analytics, advertising,
notification, email, SMS, and fraud-check integrations. Runtime source,
current first-party brand terms, and a fresh asset review remain authoritative.

## Release decision

The product owner explicitly authorized Scalius to ship current first-party
provider artwork in direct integration settings and to remove it if a provider
later objects. That authorization does not make website artwork public domain;
it is an implementation decision. Assets must still come from the provider's
own newsroom, brand kit, or website, remain unmodified, and be traceable so a
single provider can be removed without redesigning settings.

The first adoption is now source-controlled in
`apps/admin-v2/public/provider-marks/` and registered by
`provider-marks.tsx`: Stripe's current newsroom wordmark, Polar's current
brand-pack logomark, SSLCommerz's own website logo, Cloudflare's current press
kit logo, and Resend's current brand-kit icon. The registry records source,
terms page, retrieval date, intended surface, minimum rendered size, and SHA-256;
its focused test proves every local asset and digest. Provider names remain real
text and readiness stays separate from brand identity.

The prior hand-drawn Stripe, SSLCommerz, and Polar SVGs were removed. Cash on
Delivery is a Scalius commerce concept rather than a third-party mark and now
uses a semantic `CODIcon` instead of claiming to be a provider logo.

Priority meanings:

- **P0** — remove misleading or legally ambiguous identity before release.
- **P1** — adopt a reviewed official asset or strengthen the shared provider
  presentation in the next settings slice.
- **P2** — retain the safe fallback until written permission or applicable
  first-party guidance is available.

## Payment methods

| Provider | Current mark and exact code location | First-party asset availability and constraints | Safe implementation decision | Priority |
| --- | --- | --- | --- | --- |
| Stripe | Official current Blurple wordmark from Stripe's newsroom logo kit, rendered beside the provider name through `OfficialProviderMark` | [Stripe's Mark Usage Terms](https://stripe.com/legal/marks) permit truthful direct-service references and prohibit alteration or endorsement implications. | Implemented for the direct Stripe configuration card; byte and source are recorded in the manifest. | **Done** |
| SSLCommerz | Current transparent wordmark served by `sslcommerz.com`, rendered beside provider text | The reviewed [SSLCommerz developer site](https://developer.sslcommerz.com/) identifies the gateway; the asset source remains the provider's own site. | Implemented under the product-owner authorization. Do not add bKash/Nagad marks merely because the gateway can process them. | **Done** |
| Polar | Exact black/white logomarks from Polar's current brand pack | [Polar Brand](https://polar.sh/brand) requires monochrome use, clear space, and a 16 px minimum. | Implemented with separate light/dark files and a 32 px container. | **Done** |
| Cash on Delivery | Neutral Lucide banknote in `CODIcon` | Not a third-party brand; no provider permission is needed. | Implemented as a commerce concept, not a vendor logo. | **Done** |

## Delivery providers

| Provider | Current mark and exact code location | First-party asset availability and constraints | Safe implementation decision | Priority |
| --- | --- | --- | --- | --- |
| Pathao | Generic orange Lucide `Truck`; `apps/admin-v2/src/components/admin/delivery-providers/ProviderIcon.tsx:1-20,162-185` | [Pathao's press kit](https://pathao.com/press-kit/) publishes brand assets, but its [Parcel Terms](https://pathao.com/terms-of-service-parcel/) say no right or license is granted to use the company name/logo. Press availability does not override that restriction. | Keep the neutral truck and text. Obtain written integration-card permission before vendoring a Pathao mark. | **P2** |
| Steadfast | Generic blue Lucide `Package`; `apps/admin-v2/src/components/admin/delivery-providers/ProviderIcon.tsx:21-36,162-185` | The reviewed [Steadfast site](https://steadfast.com.bd/) and merchant/API surfaces do not publish an applicable mark-use license or approved integration asset pack. | Keep the neutral package and text until Steadfast grants permission or publishes applicable guidance. | **P2** |
| Unknown delivery type | Silently inherits Pathao's orange truck; `apps/admin-v2/src/components/admin/delivery-providers/ProviderIcon.tsx:162-170` | No provider identity exists for an unknown value. | Use a neutral uncolored package fallback instead of Pathao's visual. This prevents an unknown/custom provider from appearing to be Pathao. | **P1** |

RedX and Paperfly appear only in fraud-provider response summaries today; they
are not selectable delivery integrations. Do not add their marks until their
own first-class provider records and permission review exist.

## Analytics and advertising

The provider chooser uses neutral Lucide glyphs in
`apps/admin-v2/src/components/admin/AnalyticsForm.tsx:99-143`; list rows use
provider text from `analytics-list-presentation.ts:11-18`; Meta CAPI uses
generic settings/activity glyphs in
`components/admin/meta-conversions/MetaConversionsContainer.tsx:1-30` and
`MetaConversionsSettingsForm.tsx:177-188`.

| Provider | Current mark | First-party asset availability and constraints | Safe implementation decision | Priority |
| --- | --- | --- | --- | --- |
| Cloudflare Web Analytics | Generic Lucide `Cloud`; `apps/admin-v2/src/components/admin/AnalyticsForm.tsx:106-112` | [Cloudflare Trademark Guidelines](https://www.cloudflare.com/trademark/) allow truthful word references but require written permission for logos except the unrelated customer web badge. | Keep the generic cloud and “Cloudflare Web Analytics” text. Do not use the company logo without written permission. | **P2** |
| Google Analytics 4 | Generic Lucide `Activity`; `apps/admin-v2/src/components/admin/AnalyticsForm.tsx:113-118` | [Google Analytics Developer Branding](https://developers.google.com/analytics/terms/branding-policy) supplies approved horizontal/vertical logos for the covered Analytics API context, requires linkback and unmodified art, and sets 154×50 or 132×100 minimums. The current screen configures a storefront snippet and does not display Analytics API data; a 24 px selector logo would violate the documented minimum. | Keep the neutral activity glyph. If Scalius later displays Analytics API data, place the compliant full logo and linkback near that data rather than in this compact selector. | **P2** |
| Google Tag Manager | Generic Lucide `Layers3`; `apps/admin-v2/src/components/admin/AnalyticsForm.tsx:119-124` | Google's [product guidance index](https://about.google/brand-resource-center/products-and-services/) does not provide a specific compact integration-card license for Tag Manager; general Google guidance warns against unapproved product-icon use and implied affiliation. | Keep the neutral layers glyph and exact product name. Do not repurpose the Google “G” or an icon scraped from the Tag Manager UI. | **P2** |
| Meta Pixel | Generic Lucide `RadioTower`; `apps/admin-v2/src/components/admin/AnalyticsForm.tsx:125-130` | The [Meta Brand Resource Center](https://www.meta.com/brand/resources/) provides company/app assets under their individual rules, but no Meta Pixel/CAPI product mark is offered there. A Meta company, Facebook app, or WhatsApp mark is not interchangeable with Pixel. | Keep the neutral signal glyph and text. Do not use the Meta company loop as a Pixel health or partnership badge. | **P2** |
| Meta Conversions API | Generic Lucide `Settings` and `Activity`; `apps/admin-v2/src/components/admin/meta-conversions/MetaConversionsContainer.tsx:1-30`; `apps/admin-v2/src/components/admin/meta-conversions/MetaConversionsSettingsForm.tsx:177-188` | Same Meta boundary as Pixel; no reviewed CAPI-specific mark is published. | Keep the neutral operational glyphs. Share one future provider identity with Meta Pixel only if Meta publishes a product-specific rule or grants permission. | **P2** |
| TikTok Pixel | Generic Lucide `Gauge`; `apps/admin-v2/src/components/admin/AnalyticsForm.tsx:131-136` | [TikTok Developer Design Guidelines](https://developers.tiktok.com/doc/getting-started-design-guidelines) expose asset packs but explicitly require prior written permission for TikTok logos, icons, symbols, or designs. | Keep the neutral gauge and text unless written permission is recorded. | **P2** |
| Custom code | Generic Lucide `Code2`; `apps/admin-v2/src/components/admin/AnalyticsForm.tsx:137-142` | Scalius-owned concept. | Keep the semantic code glyph. | **P2** |

## Notifications, email, WhatsApp, and SMS

| Provider | Current mark and exact code location | First-party asset availability and constraints | Safe implementation decision | Priority |
| --- | --- | --- | --- | --- |
| Firebase Cloud Messaging | Text plus neutral `RadioTower` tab/status glyphs; `apps/admin-v2/src/routes/admin/settings/notifications.tsx:1-3,49-80`; no provider art in `apps/admin-v2/src/components/admin/settings/FirebaseSettingsForm.tsx:1-20` | [Firebase Brand Guidelines](https://firebase.google.com/brand-guidelines) provide assets but say the standard lockup may not be used in a product, prohibit misleading prominence/alteration, and set a 24 px minimum. The page does not clearly grant this commercial settings-card use for a standalone logomark. | Keep neutral push/radio glyphs and the full provider name. Do not import the standard lockup into product UI. | **P2** |
| Cloudflare Email | Official current Cloudflare press-kit wordmark in the provider summary and selector | Cloudflare publishes the asset through its [press kit](https://www.cloudflare.com/press/press-kit/); its trademark page remains recorded in the manifest. | Implemented under the product-owner authorization, unmodified and beside provider text. | **Done** |
| Resend | Official current black/white icon from the [Resend Brand Kit](https://resend.com/brand) in the provider summary and selector | Resend supplies both variants and says not to alter them. | Implemented with exact theme variants and adjacent text. | **Done** |
| Meta WhatsApp Cloud API | Text and readiness glyphs only; `apps/admin-v2/src/components/admin/settings/AuthSettingsBuilder.tsx:583-665` | [WhatsApp Brand Guidelines](https://www.meta.com/brand/resources/whatsapp/whatsapp-brand/) provide an official pack subject to acceptance, require current official resources, prohibit modification/endorsement implications, and allow scaling when the mark is not the most prominent feature. | Eligible for a reviewed future exact WhatsApp mark in the provider header, not a Meta company or Facebook mark. Record acceptance/retrieval and keep the text label. | **P1** |
| SMS.net.bd | Text-only selector; `apps/admin-v2/src/components/admin/settings/AuthSettingsBuilder.tsx:708-770` | The reviewed provider site/API materials do not publish an applicable integration-card asset license. | Keep text and a neutral message glyph if the future shared component requires one. | **P2** |
| BDBulkSMS / GreenWeb | Text-only selector; `apps/admin-v2/src/components/admin/settings/AuthSettingsBuilder.tsx:731-793` | The current UI links the first-party token surface, but no applicable public brand-asset permission was found. | Keep text; do not copy the website logo. | **P2** |
| MIM SMS | Text-only selector; `apps/admin-v2/src/components/admin/settings/AuthSettingsBuilder.tsx:731-832` | No applicable first-party integration-card asset license was found in the reviewed provider materials. | Keep text and neutral fallback. | **P2** |
| Gennet iSMS | Text-only selector; `apps/admin-v2/src/components/admin/settings/AuthSettingsBuilder.tsx:731-870` | No applicable first-party integration-card asset license was found in the reviewed provider materials. | Keep text and neutral fallback. | **P2** |

Readiness icons such as check, warning, draft, live, and blocked are status
semantics. They must remain separate from provider marks: a provider logo never
means configured, connected, healthy, tested, partnered, or enabled.

## Fraud-check providers

Fraud-provider rows currently use text, a small active/inactive status dot, and
status badges in
`apps/admin-v2/src/components/admin/FraudCheckerSettings.tsx:275-303`. Provider
definitions and first-party documentation links live in
`packages/core/src/modules/fraud-checker/provider.ts:5-84`.

| Provider | Current mark | First-party asset availability and constraints | Safe implementation decision | Priority |
| --- | --- | --- | --- | --- |
| Custom / Legacy API (`fraudchecker.link`) | Text and status dot; `apps/admin-v2/src/components/admin/FraudCheckerSettings.tsx:275-303`; definition at `packages/core/src/modules/fraud-checker/provider.ts:29-39` | A custom endpoint has no stable provider identity; no applicable asset license is part of the contract. | Keep a neutral shield/API glyph if needed. Never use the endpoint favicon as a provider mark. | **P2** |
| FraudBD | Text and status dot; `apps/admin-v2/src/components/admin/FraudCheckerSettings.tsx:275-303`; definition at `packages/core/src/modules/fraud-checker/provider.ts:43-56` | [FraudBD API documentation](https://fraudbd.com/api-documentation) documents the integration but does not grant an applicable public logo license. | Keep text until FraudBD provides approved assets and permission. | **P2** |
| FraudGuard | Text and status dot; `apps/admin-v2/src/components/admin/FraudCheckerSettings.tsx:275-303`; definition at `packages/core/src/modules/fraud-checker/provider.ts:57-69` | [FraudGuard API documentation](https://fraudguard.slope.com.bd/api-documentation) documents the integration but does not grant an applicable public logo license. | Keep text until approved assets and permission exist. | **P2** |
| eCourier Fraud Alert | Text and status dot; `apps/admin-v2/src/components/admin/FraudCheckerSettings.tsx:275-303`; definition at `packages/core/src/modules/fraud-checker/provider.ts:70-83` | The [eCourier Merchant API document](https://ecourier.com.bd/wp-content/uploads/eCourier_Merchant_API_Document_General_v3-7.pdf) documents API use, not reusable brand artwork or a mark license. | Keep text until eCourier provides approved assets and permission. | **P2** |

Courier names returned inside a fraud result are data attribution, not separate
configured providers. Do not turn Pathao, Steadfast, Paperfly, RedX, or other
response keys into a logo strip without a separate source/permission review.

## Asset and component contract

`OfficialProviderMark` is now the shared renderer for adopted first-party assets.
Do not add a provider to it without adding the immutable local asset and complete
manifest evidence in the same change.

Each approved asset must have a checked-in manifest entry containing:

```text
providerId
assetPathLight
assetPathDark
assetKind (icon | wordmark | lockup)
firstPartyAssetUrl
governingTermsUrl
retrievedAt
reviewedAt
reviewBy
allowedSurface
minimumWidth / minimumHeight
clearSpace
attributionOrLinkback
permissionEvidence (public-guideline | contract | written-permission)
```

The rendering component must enforce these rules:

1. The provider name is adjacent real text. The mark is decorative (`alt=""`
   or `aria-hidden="true"`) so assistive technology does not repeat the name.
2. A neutral semantic fallback exists for missing, expired, disallowed, or
   undersized marks. Unknown provider ids never inherit another provider's art.
3. Assets are local and immutable for a release; never hotlink provider CDNs or
   use third-party icon packages as a trademark source.
4. No CSS recolor, `currentColor`, crop, mask, rounded container, animation, or
   filter is applied unless the provider explicitly permits that treatment.
5. Minimum size, clear space, light/dark variant, linkback, and attribution are
   data-driven from the manifest and covered by focused rendering tests.
6. The mark is never inside a success badge and never replaces setup,
   enablement, environment, health, or buyer-visible outcome text.
7. Re-review public guidance at least every six months and before changing the
   asset. Written permission or contract-limited assets require an earlier
   review when the permission or provider relationship ends.

## Implementation order

1. **Completed payment cleanup:** the invented Stripe, SSLCommerz, and Polar
   SVGs are gone; official local assets and a semantic COD icon now render.
2. **Completed provider-mark foundation:** the typed manifest, accessible
   renderer, local assets, theme variants, source evidence, and digest test exist.
3. **P1 reviewed candidates:** assess exact Polar, Stripe, and WhatsApp assets
   in their direct configuration surfaces, including dark mode, compact sizing,
   text adjacency, and permission evidence. Do not include Google Analytics at
   compact icon size.
4. **P2 local providers:** request written integration-card permission and
   light/dark SVG assets from SSLCommerz, Pathao, Steadfast, FraudBD,
   FraudGuard, eCourier, and the four SMS providers. Neutral presentation is
   the release-safe state while those requests are pending.

## Verification

For every adopted mark, test 320, 360, 390, and 430 px plus wide desktop, both
themes, 200% zoom, forced colors, missing-asset fallback, unknown provider,
long translated provider names, and every readiness state. A screenshot is not
license evidence; a successful form save is not provider-health evidence.
