---
id: SC-YYYY-NNN
date: YYYY-MM-DD
changes: [{"snapshot": "./abi.protocol.snapshot.json", "change": "the exact change line the seal test printed"}]
---
# SC-YYYY-NNN: what is now refused, in one line

A security advisory for a change to the theme and app contract after the freeze (packages/plugin-sdk/docs/promise.md, "The security exception"). Copy this file to `SC-<year>-<number>.md`, fill it in, and give the ledger entry `"type": "security"` and `"advisory": { "id": "SC-<year>-<number>", "date": "<the date above>" }`. The seal test refuses the entry until this file exists with the same id and date, a date not in the future, and lists the entry's snapshot and exact change line under `changes` (JSON, one object per line it covers). The release notes of the release that ships it name its id (`pnpm release:check --notes <file>` refuses them otherwise).

## The hole

What could be done before, by whom, and what it exposed.

## What is refused now

The check, the exact values it now refuses, and where (theme save, install, a function's answer, a render).

## What an affected app or theme changes

The smallest change that passes again, and how an author finds out (the reason code it is refused with).
