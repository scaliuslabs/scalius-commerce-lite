# Issue taxonomy

Scalius uses GitHub's native `Bug`, `Feature`, and `Task` issue types for the kind of work. Labels add independent routing and decision metadata; they must not duplicate the issue type.

## Status

Every open issue has exactly one status label:

- `status: needs-triage` — reported but not yet independently verified or prioritized.
- `status: needs-info` — blocked on a concrete reproduction, product decision, or missing evidence.
- `status: ready` — verified, scoped, and ready to implement.

Remove the prior status label whenever the status changes. Use GitHub dependencies for blocked work rather than adding another status label.

## Priority

Apply exactly one priority only after impact and likelihood are understood:

- `priority: p0` — active security incident, data loss/corruption, broad checkout outage, or similarly critical production failure requiring immediate response.
- `priority: p1` — core commerce workflow blocked, material integrity/security risk, or severe impact without a reasonable workaround.
- `priority: p2` — meaningful user impact with a safe workaround or limited scope.
- `priority: p3` — low-impact improvement, polish, or uncommon edge case.

Priority is not a measure of how easy, interesting, or old an issue is. `needs-info` and `needs-triage` issues normally remain unprioritized until the missing facts are resolved.

## Product area

Apply the smallest set of `area: *` labels that routes the issue to its owning commerce domain. Prefer one area; use two only when ownership is genuinely shared.

- `area: auth`
- `area: catalog`
- `area: checkout`
- `area: content`
- `area: customers`
- `area: inventory`
- `area: media`
- `area: orders`
- `area: payments`
- `area: platform`
- `area: promotions`
- `area: settings`
- `area: setup`

Code package names and UI surfaces are evidence, not ownership labels. Keep `bug`/`enhancement` out of issue labeling when a native issue type already communicates that dimension.

## Triage rules

1. Confirm that the report contains one independently deliverable problem and no sensitive data.
2. Search for duplicates and link the canonical issue before closing the duplicate.
3. Set the native issue type and product area.
4. Reproduce the behavior or record the exact missing information.
5. Decide whether the behavior violates a business invariant, accessibility requirement, documented contract, or well-supported user expectation rather than an individual's taste.
6. Set `status: ready` and a priority only after that decision is supported.
7. Link the implementation PR with a closing keyword and include focused and live verification appropriate to its risk.
