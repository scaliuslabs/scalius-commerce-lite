# Provider Marks and Integration Identity

Last reviewed: 2026-07-14

This document owns the visual-identity decision for third-party providers in
merchant settings. Runtime source and current first-party materials remain
authoritative. The implementation registry is
`apps/admin-v2/src/components/admin/settings/provider-marks.tsx`.

## Release decision

The product owner explicitly authorized Scalius to use current first-party
provider artwork in direct integration settings and to remove it if a provider
later objects. That authorization is intentionally narrow: marks identify the
provider being configured, remain beside the provider's text name, and never
mean configured, healthy, connected, enabled, or partnered.

Nineteen local marks are now registered with first-party asset URL, governing
page, retrieval date, expected SHA-256, minimum display size, and allowed
surface. The focused registry test proves each file exists and still matches
its recorded digest. Unknown, custom, or unverified identities use a neutral
semantic glyph; they never inherit another provider's artwork.

The registry currently covers:

- payments: Stripe, SSLCommerz, Polar;
- analytics and advertising: Cloudflare, Google Analytics, Google Tag Manager,
  Meta, and TikTok;
- notifications and messaging: Firebase, WhatsApp, Resend, SMS.net.bd,
  BDBulkSMS, MiM SMS, and Gennet iSMS;
- delivery: Pathao and Steadfast;
- fraud checks: FraudBD and eCourier.

Cash on Delivery, custom analytics, custom delivery, legacy/custom fraud APIs,
and unknown provider values remain Scalius-owned neutral concepts.

## Source and presentation decisions

| Provider | First-party source and governing page | Implemented surface and decision |
| --- | --- | --- |
| Stripe | [Stripe logo kit](https://assets.stripeassets.com/fzn2n1nzq965/7q0dJGs6fRS1LRmMpChoAF/87def4edfbb7fd5aef4ab9baf904b2db/Stripe_logo_kit.zip), [mark terms](https://stripe.com/legal/marks) | Current Blurple wordmark in the payment card. |
| SSLCommerz | [SSLCommerz website logo](https://sslcommerz.com/wp-content/uploads/2021/11/logo.png), [provider site](https://sslcommerz.com/) | Current wordmark in the payment card. The downloaded PNG had excessive transparent outer canvas; the local derivative only crops that canvas to alpha bounds with two source pixels retained. Artwork pixels are unchanged and the registry records both source and derivative digests. |
| Polar | [Polar brand pack](https://polar.sh/assets/brand/polar_brand.zip), [brand guidance](https://polar.sh/brand) | Exact black/white theme variants in the payment card. |
| Cloudflare | [Cloudflare press kit](https://cf-assets.www.cloudflare.com/dzlvafdwdttg/2Twekn3xyYyd94qDYAl0ed/9ab649caa40958f195166e0d9f5d9a04/Logos.zip?download=true), [trademark guidance](https://www.cloudflare.com/trademark/) | Current wordmark in analytics and email-provider configuration. |
| Google Analytics | [Google Analytics suite icon](https://www.gstatic.com/analytics-suite/header/suite/v2/ic_analytics.svg), [Analytics branding policy](https://developers.google.com/analytics/terms/branding-policy) | Current Google-hosted product icon in analytics create, edit, health, list, mobile list, and filters. Provider name stays adjacent text. |
| Google Tag Manager | [Google Tag Manager suite icon](https://www.gstatic.com/analytics-suite/header/suite/v2/ic_tag_manager.svg), [Google product-brand guidance](https://about.google/brand-resource-center/products-and-services/) | Current Google-hosted product icon across analytics management. |
| Meta | [Current Meta symbol](https://static.xx.fbcdn.net/rsrc.php/yf/r/-7pQO6hUGK_.svg), [Meta company-brand resources](https://www.meta.com/brand/resources/meta/company-brand/) | Current company symbol identifies Meta Pixel and Meta Conversions API configuration. It is not used as a health or partnership badge. |
| TikTok | [TikTok developer logo pack](https://sf16-va.tiktokcdn.com/obj/eden-va2/uvzhqeh7nuhd/tt4d/logo-pack.zip), [developer design guidance](https://developers.tiktok.com/doc/getting-started-design-guidelines) | Exact square icon from the official developer pack across analytics management. |
| Firebase | [Firebase logomark](https://firebase.google.com/static/downloads/brand-guidelines/SVG/logo-logomark.svg), [brand guidelines](https://firebase.google.com/brand-guidelines) | Current logomark beside the Firebase Cloud Messaging configuration heading. |
| WhatsApp | [Current WhatsApp asset](https://static.xx.fbcdn.net/rsrc.php/yQ/r/iu_mCuZziJB.webp), [WhatsApp brand resources](https://www.meta.com/brand/resources/whatsapp/whatsapp-brand/) | Current mark beside WhatsApp Cloud API configuration. |
| Resend | [Resend icon](https://cdn.resend.com/brand/resend-icon-black.svg), [brand kit](https://resend.com/brand) | Exact black/white theme variants in email-provider configuration. |
| Pathao | [Pathao press-kit logo](https://pathao.com/wp-content/uploads/2023/10/Pathao-logo.svg), [press kit](https://pathao.com/press-kit/) | Current wordmark identifies the Pathao delivery integration. |
| Steadfast | [Steadfast site logo](https://steadfast.com.bd/landing-page/asset/images/logo/logo.svg), [provider site](https://steadfast.com.bd/) | Current wordmark identifies the Steadfast delivery integration. Unknown/custom delivery types use a neutral package. |
| FraudBD | [FraudBD site logo](https://fraudbd.com/storage/assets/images/logo_with_name.png), [API documentation](https://fraudbd.com/api-documentation) | Current wordmark in the provider list, selector, and selected-provider detail. |
| eCourier | [eCourier site logo](https://ecourier.com.bd/wp-content/themes/ecourier-2.0/images/logo.svg), [media resources](https://ecourier.com.bd/resources/) | Current wordmark for the eCourier Fraud Alert provider. |
| SMS.net.bd | [SMS.net.bd/Alpha SMS site logo](https://sms.net.bd/Content/img/logo/alphasms.svg), [provider site](https://sms.net.bd/) | Current wordmark in the SMS provider selector and selected-provider summary. |
| BDBulkSMS by GreenWeb | [BDBulkSMS site logo](https://cdn.bdbulksms.com/logo_bdbulksms.webp), [BDBulkSMS terms](https://bdbulksms.com/terms-and-conditions.php) | The BDBulkSMS wordmark is used, not a parent-company favicon. The provider's own terms state that Green Web Bangladesh directly provides the site's content and services, proving the existing UI label's ownership relationship. |
| MiM SMS | [MiM SMS site logo](https://www.mimsms.com/storage/2021/04/MiM-SMS-Transparent-Logo.png), [provider site](https://www.mimsms.com/) | Current wordmark in the SMS provider selector and summary. |
| Gennet iSMS | [Gennet site logo](https://www.gennet.com.bd/assets/img/logo.png), [provider site](https://www.gennet.com.bd/) | Current wordmark in the SMS provider selector and summary. |

## FraudGuard identity boundary

The configured FraudGuard integration points to
`fraudguard.slope.com.bd`. That host was not resolvable during this review, and
no first-party evidence ties it to the similarly named `fraudguard.shop` site.
Scalius therefore keeps a neutral shield for FraudGuard. Do not add a
FraudGuard mark until the exact configured operator publishes or supplies an
asset and the identity relationship can be proved.

The legacy/custom fraud endpoint also remains a neutral shield because a custom
endpoint has no stable provider identity. Courier names returned inside fraud
results are data attribution, not configured integrations; do not turn Pathao,
Steadfast, Paperfly, RedX, or arbitrary response keys into an unreviewed logo
strip.

## Component contract

`OfficialProviderMark` is the shared renderer for adopted provider assets. Do
not add a provider without adding the immutable local asset, registry evidence,
and digest test in the same change.

1. The provider name is adjacent real text. The mark is decorative
   (`alt=""` and `aria-hidden="true"`) so assistive technology does not repeat
   the name.
2. Provider identity and readiness remain separate. A logo never replaces
   setup, enablement, environment, health, test, or buyer-visibility text.
3. Unknown/custom values use a neutral semantic fallback. They never inherit a
   known provider's mark.
4. Assets are local and immutable for a release; provider CDNs are provenance,
   not runtime dependencies.
5. No recolor, mask, animation, or artwork edit is allowed without explicit
   provider guidance. The SSLCommerz transparent-canvas crop is recorded as a
   derivative exception and does not alter artwork pixels.
6. Wordmarks use a wider white presentation frame so their intrinsic aspect
   ratio remains legible in light and dark themes. Compact selectors use the
   small size; primary settings cards use the medium size.
7. Re-review sources before changing an asset and at least every six months.

## Verification and remaining work

The registry test validates all 19 local file hashes and the SSLCommerz
derivative provenance. Focused presentation tests cover analytics provider
mapping, mobile list rendering, delivery unknown-provider fallback, and the
fraud identity boundary.

For future visual QA, inspect 320, 360, 390, and 430 px plus wide desktop, both
themes, 200% zoom, missing-image behavior, unknown provider values, long labels,
and every readiness state. Remaining identity work is deliberately limited to
the exact configured FraudGuard operator and any future first-class integration;
it is not acceptable to fill those gaps with lookalike brands or favicons.
