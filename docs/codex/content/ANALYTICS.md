# Analytics Administration Audit

Last reviewed: 2026-07-12

## Verified current strengths

- Browser script types cover GA4, GTM, Meta Pixel, TikTok Pixel, Cloudflare Web
  Analytics, and explicit custom code.
- Server validation rejects obvious placeholders and provider/type mismatches;
  Cloudflare Web Analytics canonicalizes a real token to the official beacon,
  stays off Partytown, and public injection fails closed for unsafe active rows.
- Provider health separates browser readiness from server-side Meta CAPI state,
  and layout caches invalidate after script mutations.
- RBAC distinguishes view, create, edit, toggle, and delete behavior.

## P1 authority/workflow defects

1. Scripts have no version/CAS. Edit and activation can overwrite another
   operator. Create defaults Active instead of a safe Draft.
2. List reads silently cap at 50 and the UI paginates only the already-loaded
   array. There is no URL-backed server search/provider/status/readiness sort or
   truthful total.
3. List responses expose complete script source even though rows only need safe
   summary/readiness fields. Public configuration also returns more row fields
   than injection requires.
4. Delete is immediate hard delete. Operational/audit recovery needs trash or a
   retained inactive tombstone; active deletion must be explicit.
5. Provider validation logic is duplicated in the React form and core. The UI
   can drift from the actual activation authority.
6. Provider-first use cases are forced through one raw 240px code textarea,
   location terminology, and Partytown details. Most merchants need an ID/token
   form, generated snippet, readiness, and test guidance; raw code is Advanced.
7. Multiple active scripts for the same singleton-style provider/account are
   not diagnosed. Duplicate page-view injection can corrupt metrics and should
   be an explicit advanced decision, not an accidental default.

## UI direction

- Compact provider rows/cards show Provider, identifier/account mask, browser
  status, server status when relevant, placement/performance mode, and last
  update. One switch opens activation readiness rather than blindly toggling.
- Top-level health strip summarizes Ready, Draft, and Needs attention; filters
  and pagination use the shared dense table grammar.
- Creation begins with provider tiles. Common providers request the minimum
  identifier/token and generate canonical code. Advanced reveals location,
  Partytown compatibility, and the generated snippet; Custom Script alone starts
  with the code editor.
- Default is Draft. “Activate” is a distinct, readiness-gated action. Preserve
  drafts and show exactly which identifier/snippet/server credential is missing.
- Cloudflare Web Analytics is the first recommended privacy/performance-friendly
  path when the merchant has a Cloudflare site token; never auto-enable it.

## Accepted architecture

- Add positive script version and expected-version commands for edit, activate,
  deactivate, trash, and restore. Public injection reads active validated rows.
- Make the list server-paginated and return safe summaries plus provider-health
  status. Detail returns source only to authorized editors.
- Provider-specific structured config is the authority for first-class types;
  canonical snippet generation belongs in core. Keep arbitrary trusted code
  only for `custom`, clearly labelled as running on every buyer page.
- Add duplicate-provider/account diagnostics and activation confirmation when a
  second page-view emitter is intentional.
- Retain an audit-safe tombstone/revision for deleted scripts. Do not preserve
  the current hard-delete behavior for compatibility.

## Verification bar

- 50/51+ list pagination, search/filter/sort, concurrent edit/toggle, inactive
  draft with placeholder, activation readiness, duplicate provider diagnostics,
  trash/restore, and exact RBAC.
- Provider ID/token forms generate the same canonical code core injects; no
  duplicated client validator is authoritative.
- Public payload minimization, cache freshness, Partytown/main-thread rules,
  CSP-compatible output where configured, and no duplicate PageView from an
  unacknowledged second provider instance.
