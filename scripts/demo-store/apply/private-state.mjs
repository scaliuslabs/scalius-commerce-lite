import { chmod, lstat, mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_JSON_BYTES = 20 * 1024 * 1024;
const MAX_RESUME_BYTES = 10 * 1024 * 1024;
const MAX_RESUME_LINES = 20_000;

function childPath(candidate, privateRoot, label) {
  const resolved = path.resolve(candidate);
  const relative = path.relative(privateRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a child of the workspace .wrangler directory.`);
  }
  return resolved;
}

async function assertRealDirectory(directory, privateRoot, label) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const [link, info, realRoot, realDirectory] = await Promise.all([
    lstat(directory), stat(directory), realpath(privateRoot), realpath(directory),
  ]);
  const relative = path.relative(realRoot, realDirectory);
  if (link.isSymbolicLink() || !info.isDirectory() || (!relative && directory !== privateRoot)
    || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a real private directory inside .wrangler.`);
  }
  await chmod(directory, 0o700);
}

export async function preparePrivateApplyPaths({
  workspaceDir = process.cwd(),
  evidenceDir = path.resolve(workspaceDir, ".wrangler/demo-store-apply/evidence"),
  resumeFile,
  intentFingerprint,
}) {
  if (!/^[a-f0-9]{64}$/u.test(intentFingerprint ?? "")) throw new Error("Private apply paths require the full intent fingerprint.");
  const privateRoot = path.resolve(workspaceDir, ".wrangler");
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const rootLink = await lstat(privateRoot);
  if (rootLink.isSymbolicLink()) throw new Error("Workspace .wrangler must not be a symbolic link.");
  await chmod(privateRoot, 0o700);
  const resolvedEvidence = childPath(evidenceDir, privateRoot, "Apply evidence directory");
  const resolvedResume = childPath(
    resumeFile ?? path.resolve(workspaceDir, `.wrangler/demo-store-apply/resume-${intentFingerprint}.jsonl`),
    privateRoot,
    "Apply resume journal",
  );
  await assertRealDirectory(resolvedEvidence, privateRoot, "Apply evidence directory");
  await assertRealDirectory(path.dirname(resolvedResume), privateRoot, "Apply resume directory");
  return { privateRoot, evidenceDir: resolvedEvidence, resumeFile: resolvedResume };
}

async function assertPrivateFile(filePath, label, { optional = false } = {}) {
  let link;
  try { link = await lstat(filePath); } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw error;
  }
  if (link.isSymbolicLink() || !link.isFile()) throw new Error(`${label} must be a regular private file.`);
  if ((link.mode & 0o077) !== 0) throw new Error(`${label} permissions must exclude group and other access.`);
  return link;
}

export async function readPrivateApplyJson(filePath, {
  workspaceDir = process.cwd(),
  label = "Apply JSON input",
} = {}) {
  const privateRoot = path.resolve(workspaceDir, ".wrangler");
  const resolved = childPath(filePath, privateRoot, label);
  const info = await assertPrivateFile(resolved, label);
  if (info.size > MAX_JSON_BYTES) throw new Error(`${label} exceeds its safe size limit.`);
  const text = await readFile(resolved, "utf8");
  try { return JSON.parse(text); } catch { throw new Error(`${label} is not valid JSON.`); }
}

export async function readPrivateResumeRecords(filePath) {
  const info = await assertPrivateFile(filePath, "Apply resume journal", { optional: true });
  if (!info) return [];
  if (info.size > MAX_RESUME_BYTES) throw new Error("Apply resume journal exceeds its size bound.");
  const lines = (await readFile(filePath, "utf8")).split("\n").filter(Boolean);
  if (lines.length > MAX_RESUME_LINES) throw new Error("Apply resume journal exceeds its line bound.");
  return lines.map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`Apply resume journal line ${index + 1} is not valid JSON.`); }
  });
}

export async function appendPrivateResumeRecord(filePath, record) {
  const handle = await open(filePath, "a", 0o600);
  try {
    await chmod(filePath, 0o600);
    await handle.write(`${JSON.stringify(record)}\n`);
  } finally {
    await handle.close();
  }
}

export async function writePrivateApplyEvidence(runDir, value) {
  const filePath = path.resolve(runDir, "apply-result.json");
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return filePath;
}
