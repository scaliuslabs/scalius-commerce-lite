import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const patchUrl = new URL(
  "../patches/@flue__runtime@1.0.0-beta.9.patch",
  import.meta.url,
);
const lockfileUrl = new URL("../pnpm-lock.yaml", import.meta.url);
const runtimeArtifact = (app, file) =>
  new URL(`../apps/${app}/node_modules/@flue/runtime/dist/${file}`, import.meta.url);

const FENCE_ARTIFACTS = [
  "internal.mjs",
  "flue-app-DweeRG3g.mjs",
  "conversation-projections-XMug3C6A.mjs",
  "types-USSZhfC6.d.mts",
  "agent-execution-store-BCmrE5Jm.d.mts",
];
const EXECUTABLE_FENCE_ARTIFACTS = FENCE_ARTIFACTS.filter((file) =>
  file.endsWith(".mjs")
);

describe("Flue runtime policy patch", () => {
  it("does not expose recursive task delegation when an agent declares no subagents", async () => {
    const [patch, lockfile] = await Promise.all([
      readFile(patchUrl, "utf8"),
      readFile(lockfileUrl, "utf8"),
    ]);

    expect(lockfile).toContain("'@flue/runtime@1.0.0-beta.9':");
    expect(lockfile).toContain("patchedDependencies:");
    expect(patch).toContain(
      "Object.keys(this.config.subagents ?? {}).length > 0 ? createTaskTool",
    );
    expect(patch).toContain("tools: frameworkTools");
  });

  it("fences delayed Cloudflare Agent admissions inside the existing Durable Object", async () => {
    for (const app of ["admin-agent-flue", "storefront-agent-flue"]) {
      for (const file of EXECUTABLE_FENCE_ARTIFACTS) {
        execFileSync(process.execPath, [
          "--check",
          fileURLToPath(runtimeArtifact(app, file)),
        ]);
      }
    }

    const [patch, lockfile, ...installedArtifacts] = await Promise.all([
      readFile(patchUrl, "utf8"),
      readFile(lockfileUrl, "utf8"),
      ...["admin-agent-flue", "storefront-agent-flue"].flatMap((app) =>
        FENCE_ARTIFACTS.map((file) => readFile(runtimeArtifact(app, file), "utf8"))
      ),
    ]);

    expect(lockfile).toContain(
      "'@flue/runtime': 1.0.0-beta.9(patch_hash=",
    );
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS flue_agent_admission_fence");
    expect(patch).toContain(
      'const FLUE_ADMISSION_GENERATION_HEADER = "x-flue-admission-generation"',
    );
    expect(patch).toContain(
      'const FLUE_ABORT_THROUGH_GENERATION_HEADER = "x-flue-abort-through-generation"',
    );
    expect(patch).toContain(
      "ON CONFLICT(singleton) DO UPDATE SET cutoff = max(cutoff, excluded.cutoff)",
    );
    expect(patch).toContain(
      "return generation === void 0 || generation > readCutoff()",
    );
    expect(patch).toContain(
      "if (cutoff.value !== void 0) this.admissionFence.advance(cutoff.value)",
    );
    expect(patch).toContain(
      "if (!this.admissionFence.allows(generation)) throw new InvalidRequestError",
    );
    expect(patch).toContain(
      "if (!this.admissionFence.allows(input.generation)) return Response.json",
    );
    expect(patch).toContain(
      'Agent dispatch generation was fenced by a later abort." }, { status: 409 }',
    );
    expect(patch).toContain(
      'return Response.json({ error: `Invalid ${name} header.` }, { status: 400 })',
    );
    expect(patch).toContain(
      "request.generation !== void 0 && (!Number.isSafeInteger(request.generation) || request.generation <= 0)",
    );
    expect(patch).toContain("generation?: number;");

    const [
      adminInternal,
      adminDispatch,
      adminValidation,
      adminPublicTypes,
      adminStoreTypes,
      storefrontInternal,
      storefrontDispatch,
      storefrontValidation,
      storefrontPublicTypes,
      storefrontStoreTypes,
    ] = installedArtifacts;

    for (const internal of [adminInternal, storefrontInternal]) {
      const advance = internal.indexOf(
        "this.admissionFence.advance(cutoff.value)",
      );
      const abort = internal.indexOf(
        "const aborted = await this.abortInstance()",
        advance,
      );
      const directGuard = internal.indexOf(
        "if (!this.admissionFence.allows(generation))",
      );
      const directAdmission = internal.indexOf(
        "this.submissions.admitDirect(input)",
        directGuard,
      );
      const dispatchGuard = internal.indexOf(
        "if (!this.admissionFence.allows(input.generation))",
      );
      const dispatchAdmission = internal.indexOf(
        "this.submissions.admitDispatch(input)",
        dispatchGuard,
      );

      expect(internal).toContain(
        "CREATE TABLE IF NOT EXISTS flue_agent_admission_fence",
      );
      expect(advance).toBeGreaterThan(-1);
      expect(abort).toBeGreaterThan(advance);
      expect(directGuard).toBeGreaterThan(-1);
      expect(directAdmission).toBeGreaterThan(directGuard);
      expect(dispatchGuard).toBeGreaterThan(-1);
      expect(dispatchAdmission).toBeGreaterThan(dispatchGuard);
      expect(internal).toContain(
        'Agent dispatch generation was fenced by a later abort." }, { status: 409 }',
      );
      expect(internal).toContain(
        'return Response.json({ error: `Invalid ${name} header.` }, { status: 400 })',
      );
      expect(internal).toContain(
        "return generation === void 0 || generation > readCutoff()",
      );
    }

    for (const dispatch of [adminDispatch, storefrontDispatch]) {
      expect(dispatch).toContain("generation: validated.generation");
      expect(dispatch).toContain(
        "dispatch() generation must be a positive safe integer",
      );
    }
    for (const validation of [adminValidation, storefrontValidation]) {
      expect(validation).toContain(
        "input.generation === void 0 || Number.isSafeInteger(input.generation)",
      );
    }
    for (const types of [
      adminPublicTypes,
      adminStoreTypes,
      storefrontPublicTypes,
      storefrontStoreTypes,
    ]) {
      expect(types).toContain("generation?: number;");
    }
  });
});
