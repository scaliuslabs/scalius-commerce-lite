# Activation and Publishing Permission Boundary

Last reviewed: 2026-07-13

Pages, Analytics scripts, and Discounts are draft/inactive by default. Their
create and ordinary edit permissions do not grant buyer-facing publication or
activation authority.

- Page lifecycle and publication-schedule changes require `pages.publish`.
- Analytics lifecycle changes require `analytics.toggle`.
- Discount lifecycle changes require `discounts.toggle_status`.

The API route passes the authenticated permission snapshot into core. Core
compares requested lifecycle state with the current state and fails with 403
when it changes without the dedicated permission. Repeating an unchanged state
does not prevent an authorized content editor from saving an already-public
resource. Dedicated publish/toggle commands remain the preferred lifecycle
workflow, and admin form switches default off and disable themselves when the
operator lacks the lifecycle permission.

The replacement `/admin/promotions` authority currently exposes draft CRUD,
archive, and revision-claimed preview only. It intentionally has no activation
route while checkout still uses legacy one-code discounts; the eventual
promotion lifecycle command must require `discounts.toggle_status` before it
can create buyer-visible behavior.
