// A per-colo hint in the Workers Cache API, keyed by the Worker version (a
// deploy starts empty). A hint is never authority: a miss costs a database
// read, never correctness. Null without the Cache API or a valid version, so
// callers fall through to the database.

export interface WorkerCacheHint {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const WORKER_VERSION_PATTERN = /^[0-9A-Za-z-]{1,64}$/;

/** `name` is a lowercase label: cache `scalius-<name>`, keys under `https://<name>.internal/<version>/`. */
export function workerCacheHint(
  env: { CF_VERSION_METADATA?: { id?: unknown } | null } | null | undefined,
  name: string,
  ttlSeconds: number,
): WorkerCacheHint | null {
  const version = env?.CF_VERSION_METADATA?.id;
  if (typeof version !== "string" || !WORKER_VERSION_PATTERN.test(version)) return null;
  if (typeof caches === "undefined") return null;
  const open = () => caches.open(`scalius-${name}`);
  const url = (key: string) => `https://${name}.internal/${version}/${encodeURIComponent(key)}`;
  return {
    async get(key) {
      const hit = await (await open()).match(url(key));
      return hit ? await hit.text() : null;
    },
    async put(key, value) {
      await (await open()).put(
        url(key),
        new Response(value, { headers: { "Cache-Control": `max-age=${ttlSeconds}` } }),
      );
    },
    async delete(key) {
      await (await open()).delete(url(key));
    },
  };
}
