# Issue taxonomy

This page is for maintainers who triage issues. Scalius uses GitHub's native `Bug`, `Feature`, and `Task` issue types. The issue forms set the type (`Bug` or `Feature`) and the label `status: needs-triage`. Labels add routing metadata and must not repeat the issue type.

## Status

Every open issue has exactly one status label:

- `status: needs-triage`: reported, not yet verified or prioritized.
- `status: needs-info`: blocked on a reproduction, a product decision, or missing evidence.
- `status: ready`: verified, scoped, and ready to implement.

Remove the old status label when the status changes. Use GitHub dependencies for blocked work, not another label.

## Priority

Set one priority only after you understand the impact and likelihood:

- `priority: p0`: active security incident, data loss or corruption, broad checkout outage, or a similar production failure that needs an immediate response.
- `priority: p1`: a core commerce workflow is blocked, a material integrity or security risk, or severe impact with no reasonable workaround.
- `priority: p2`: meaningful user impact with a safe workaround or a limited scope.
- `priority: p3`: low-impact improvement, polish, or an uncommon edge case.

Priority does not measure how easy, interesting, or old an issue is. Leave `needs-info` and `needs-triage` issues unprioritized until the missing facts arrive.

## Product area

Set the fewest `area: *` labels that route the issue to its owning commerce domain. Prefer one. Use two only when ownership is shared.

`area: auth`, `area: catalog`, `area: checkout`, `area: content`, `area: customers`, `area: inventory`, `area: media`, `area: orders`, `area: payments`, `area: platform`, `area: promotions`, `area: settings`, `area: setup`.

Code package names and UI surfaces are evidence, not ownership labels. Do not add `bug` or `enhancement`: the issue type already carries that.

## Triage rules

1. Confirm that the report has one independently deliverable problem and no sensitive data.
2. Search for duplicates. Link the canonical issue before you close the duplicate.
3. Set the issue type and the product area.
4. Reproduce the behavior, or record the exact missing information.
5. Decide whether the behavior breaks a business invariant, an accessibility requirement, a documented contract, or a well-supported user expectation, rather than one person's taste.
6. Set `status: ready` and a priority only after that decision is supported.
7. Link the implementation pull request with a closing keyword. Include focused and live verification that match its risk.
