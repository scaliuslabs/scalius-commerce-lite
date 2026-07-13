import { listPaged } from "../api-read.mjs";

async function exactFromList(readClient, command, path, key, collectionKey) {
  const rows = await listPaged(readClient, { path, collectionKey, label: `Resolve ${command.logicalKey}` });
  const matches = rows.filter((row) => row[key] === command.identity[key]);
  if (matches.length > 1) throw new Error(`Exact identity is ambiguous for ${command.logicalKey}.`);
  return matches[0] ?? null;
}

export function createDemoLifecycleRuntime(readClient) {
  return {
    async resolveCurrent(command) {
      if (command.logicalKey.startsWith("category:")) {
        if (command.identity?.id) return readClient.get(`/api/v1/admin/categories/${encodeURIComponent(command.identity.id)}`, command.logicalKey);
        return exactFromList(readClient, command, "/api/v1/admin/categories", "slug", "categories");
      }
      throw new Error(`No lifecycle resolver for ${command.logicalKey}.`);
    },
    async matchesDesired(command, current) {
      if (command.logicalKey.endsWith(":publish")) return current.status === command.body.status;
      return current.slug === command.body.slug
        && current.name === command.body.name
        && current.description === command.body.description
        && (command.body.status === undefined || current.status === command.body.status);
    },
  };
}
