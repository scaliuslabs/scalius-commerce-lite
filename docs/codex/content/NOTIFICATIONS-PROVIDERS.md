# Notification and Provider Presentation Contract

Last reviewed: 2026-07-14

This document owns the boundary between notification policy, delivery-provider
setup, and provider-brand presentation. Runtime code, provider terms, focused
tests, and fresh production evidence remain authoritative.

## One authority per merchant decision

- `/admin/settings/notifications?section=rules` is the only notification event
  policy editor. It decides which order/support events target customer email,
  SMS, WhatsApp, or administrator push.
- `/admin/settings/notifications?section=push` configures Firebase Cloud
  Messaging for administrator browser push. Provider setup is not an event
  rule and must not silently enable or disable one.
- General settings no longer mounts a second copy of the notification rule
  editor. The duplicate allowed two URLs, two permission contexts, and two
  indistinguishable save surfaces for the same D1 authority.
- Provider readiness may lock an unavailable channel and explain the repair,
  but a provider credential save is not a delivery test and must not be shown
  as one.

Current provider setup is still split by historical workflow:

| Delivery capability | Current setup surface | Shared consumers | Target ownership |
| --- | --- | --- | --- |
| Transactional email | General > Email | Order notifications, OTP, recovery | Communication providers |
| SMS | General > Auth & Access | Order notifications, OTP, recovery | Communication providers |
| Meta WhatsApp Cloud API | General > Auth & Access | Order notifications, OTP, recovery | Communication providers |
| Administrator browser push | Notifications > Admin push | Administrator order/support alerts | Notification providers |

SMS and WhatsApp credentials are not auth-only facts. A later cutover should
move the shared provider settings into one communication-provider workspace and
leave Auth & Access with readiness links plus OTP policy. Do not duplicate the
credential inputs during that migration: move the existing settings authority,
preserve strict encrypted reads, and update every order/OTP readiness projection
in the same slice.

## Provider mark rules

An official website containing a logo is not, by itself, a reusable-asset
license. Provider marks may be shown only when the provider's current first-party
terms permit this integration context.

- Vendor the approved asset locally; never hotlink a provider logo into the
  dashboard and never download from an icon aggregator.
- Record provider id, local file, first-party asset URL, governing terms URL,
  retrieval date, allowed context, minimum size/clear-space rules, and supplied
  light/dark variants in a manifest beside the assets.
- Keep the accessible provider name as real text. Decorative marks use empty
  alternative text so screen readers do not repeat the provider name.
- Do not recolor, redraw, crop, animate, or place a mark on a background that
  violates its guidance. A neutral product glyph or initials are the fallback.
- A mark identifies a configured integration; it never means connected,
  healthy, certified, partnered, or endorsed. Readiness and last test evidence
  remain separate text/status facts.
- Compact cards must not force a logo below the provider's minimum size. Use the
  neutral fallback when a permitted wordmark cannot fit honestly.

The current source is inconsistent but safely reversible:

- `payment-gateway-utils.tsx` labels four hand-drawn product glyphs as gateway
  logos. They are not official Stripe, SSLCommerz, or Polar assets and must not
  be presented as such.
- Delivery providers use generic Lucide truck/package glyphs; Analytics and Meta
  CAPI use generic activity/layer/radio glyphs; Fraud Checker is primarily text.
  These neutral fallbacks are preferable to copied or redrawn trademarks until
  reviewed assets are available.
- A shared provider-mark component should replace these one-off maps only after
  its checked-in manifest has at least one compliant real asset. Do not create a
  central registry that merely centralizes invented marks.

## First-party source review

| Provider | First-party source | Decision for compact admin cards |
| --- | --- | --- |
| Firebase | `https://firebase.google.com/brand-guidelines` | Do not ship a Firebase mark yet. The guidance limits product use and sets a 24 px minimum; retain a neutral push/provider glyph until the intended integration-card use is confirmed compatible. |
| Google Analytics | `https://developers.google.com/analytics/terms/branding-policy` | The supplied logos are permitted only under the stated API/branding rules, require linkback, and have 154×50 or 132×100 minimums. Do not shrink them into a 24 px list icon; use text plus a neutral glyph in compact controls. |
| TikTok | `https://developers.tiktok.com/doc/getting-started-design-guidelines` | Do not ship a TikTok mark without the permission required by the first-party design guidelines. The availability of an asset pack does not remove that condition. |
| Stripe | `https://stripe.com/newsroom/information` and `https://stripe.com/marks/legal` | The official kit is governed by the Marks Usage Agreement. Replace the current hand-drawn approximation only with an unmodified supplied asset after the intended merchant integration-card use is checked against those terms. |
| Meta | `https://about.meta.com/brand/resources/` | Source only the current first-party asset and terms. Keep the neutral fallback until the exact Meta/WhatsApp/Pixel mark and this setup context are approved; company, app, and product marks are not interchangeable. |
| Pathao, Steadfast, SSLCommerz, local SMS/fraud providers | Provider-owned site or written asset pack | A logo visible on the provider website is not enough. Keep text plus neutral glyphs until each provider publishes applicable usage terms or grants permission. |

This review deliberately does not import provider images. It prevents replacing
generic glyphs with legally ambiguous or incorrectly sized marks while still
establishing the asset contract needed for a later visual cutover.

## Release proof

Before calling the notification/provider workspace complete:

1. Verify the rules and push URLs survive reload/history and are usable at 320,
   360, 390, and 430 px without table clipping.
2. Exercise read failure, permission denial, dirty/reset/save, provider-blocked,
   provider-recovered, queue retry, receipt dedupe, DLQ, and stale-device flows.
3. Move shared Email/SMS/WhatsApp setup into one provider authority without
   duplicating or weakening encrypted credentials.
4. Add only reviewed official assets with a checked-in source/terms manifest,
   light/dark evidence, accessible labels, and neutral fallbacks.
5. Deploy and prove event-rule changes and provider recovery against real order,
   support-request, OTP, and administrator push outcomes.
