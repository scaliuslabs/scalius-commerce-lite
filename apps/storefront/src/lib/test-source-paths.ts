import { resolve } from "node:path";

function storefrontRoot(): string {
  const cwd = process.cwd();
  return cwd.replace(/\\/g, "/").endsWith("/apps/storefront")
    ? cwd
    : resolve(cwd, "apps/storefront");
}

export function storefrontSourcePath(...segments: string[]): string {
  return resolve(storefrontRoot(), "src", ...segments);
}

export function storefrontRootPath(...segments: string[]): string {
  return resolve(storefrontRoot(), ...segments);
}
