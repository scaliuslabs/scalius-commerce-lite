# Burst notes: SDK developer essentials (DX-1..DX-5)

Branch commits, oldest first: `5c4bb529f` (createContractApi), `9a404cb8a` (manifest typing), `e0bc0de4b` (`pnpm plugin` CLI), `2d9f9622f` (README), `9eb052bb0` (ABI declaration snapshot).

## Verified locally

- Targeted vitest, all green (65 tests): `packages/plugin-sdk/src/{testing-contract,manifest-types,testing}.test.ts`, `scripts/{plugin-contract,plugins,plugin-dev,plugin-registry,plugin-storefront}.test.mjs`.
- `packages/shared/src/plugins/abi.snapshot.test.ts -t "SDK export map"`, updated with `-u`. The diff is additive: new exports, and new optional type parameters with defaults on the handler types and `PluginDefinition`.
- One `tsc --build` of `packages/plugin-sdk` (tsgo): clean.
- A scratch typecheck (tsgo, outside the workspace graph) of the generated scaffold (`index.ts`, `storefront.tsx`, `index.test.ts`) against SDK source: clean.

## Not verified (the lead should run these)

1. **Workspace typecheck.** `definePlugin` is now `definePlugin<const M, const T extends PluginDefinition<M>>(definition: T & { manifest: M })`. Only a `defineManifest` manifest (branded) opts into typed contexts, and everything else resolves to `PluginContext` as before. Still, check that `plugins/bangladesh`, `plugins/noor`, `apps/api/src/plugins/testing/apps/*` and `apps/api` compile. No caller passes explicit type arguments (grep: none).
2. **The published package outside the repo.** No npm publish was made. `pnpm --dir packages/plugin-sdk pack`, then `npm install <tgz>` into a standalone scaffold, then `npm test` / `npm run typecheck` is documented in the README but was not run. `scripts/plugins.test.mjs` proves only that validate and pack of a standalone scaffold in the OS temp dir work with no `node_modules` (the fallback to the repo SDK).
3. **The dist build.** `node scripts/build-plugin-sdk.mjs` was not run. `testing-contract.gen.ts` (about 270 KB, the snapshot as one JSON string) is inlined into `dist/testing.js`.
4. **The CLI end to end.** These run only inside the tests: `pnpm plugin create --dir <outside>`, `pnpm --dir <repo> plugin validate|preview|pack <outside app>` and `pack --key <folder>`.
5. **The README's dashboard steps** ("Install and activate an app locally") were written from the code (`bundled-sync.ts`, `lifecycle.ts`), not clicked through. QA finding DOC-01 itself was not found in the repo. The section answers the local install and activation gap as the brief describes it.
6. **The money object field type.** `ObjectFieldValue<"money">` is `number | string`, because the record wire format (`objectDataWire` to `customFieldWireValue`) was not confirmed. Narrow it once confirmed.

## Not done (deferred, with reasons)

- **`defineStorefront<typeof manifest>()` (task 3).** Its home, `packages/plugin-sdk/src/storefront/define.ts`, is owned by another worker. The additive type is shipped instead: `StorefrontSettingsOf<typeof manifest, "section" | "block" | "skin", key>`, exported from the root and used by the scaffold. Suggested overload for the storefront owner, in `define.ts`:
  ```ts
  export function defineStorefront<M>(): (definition: {
    sections?: { [K in SectionTypes<M>]?: (props: SectionProps<StorefrontSettingsOf<M, "section", K>>) => Renderable };
    blocks?: …; skins?: …;
  }) => StorefrontModuleDefinition;
  ```
  The no-argument call returns the existing `defineStorefront`.
- **A standalone `scalius` CLI** (`npx scalius app validate`) shipped inside the SDK package. The tooling still runs from a Scalius checkout (`pnpm --dir <repo> plugin …`), because `plugin-build.mjs` compiles the contract from `packages/shared` source and needs the repo's esbuild. Shipping it means bundling `loadPluginContract` and the packer into `dist/cli.js` with a `bin` entry.
- **`pnpm plugin add <outside path>`** still refuses a path outside the repository: lockfile sources must be repo-relative for the generated import. The README says to install the app as a package, or to copy it under `plugins/`.
- **A host wart, outside my ownership.** `apps/api/src/plugins/api-call.ts` `unwrap()` reports a route's Zod validation failure as code `ERROR`, with a JSON-string message, because a Zod error body has no `code`. `createContractApi` returns `VALIDATION_ERROR` (what MCP maps it to). One line in `unwrap` would make the host match: `error.name === "ZodError" ? "VALIDATION_ERROR"`.
- **`createContractApi` limits.**
  - It does not check `format` (dates, uuid, email).
  - It treats `oneOf` like `anyOf`.
  - It checks a scope only when one scope alone covers the operation.
  - It models 404 for any id outside the snapshot. The host answers `api.operation_not_stable` for a real beta operation.

## Refresh rule

The SDK carries `apps/api/src/openapi/stable-operations.snapshot.json` as `packages/plugin-sdk/src/testing-contract.gen.ts`. After the API's stable-operations snapshot changes, run `node scripts/plugin-contract.mjs`. `scripts/plugin-contract.test.mjs` fails until you do.
