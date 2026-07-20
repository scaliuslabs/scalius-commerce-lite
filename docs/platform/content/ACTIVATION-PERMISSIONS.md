# Activation and Publishing Permission Boundary

Last reviewed: 2026-07-20

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

The replacement `/admin/promotions` authority exposes revision-claimed draft
CRUD, preview, activation, pause, and archive. Activation and pause require
`discounts.toggle_status`; creation and ordinary rule edits do not grant that
authority. Activation is currently restricted to an internally consistent
code promotion with at least one active code and one active effect. Automatic
promotion activation remains unavailable until checkout can evaluate it.

The deployed Promotions UI mirrors this boundary: create and save use the
operator's exact discount create/edit permission, Activate/Pause are absent or
disabled without `discounts.toggle_status`, and Archive requires the discount
delete authority. The browser does not infer permission from button presence;
the API and core remain authoritative and revision-CAS every lifecycle command.
