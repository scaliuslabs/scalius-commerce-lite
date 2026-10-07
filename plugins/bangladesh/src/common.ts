// Small pieces the gateways and checkers share: reading the app's settings,
// the platform's error codes and a multipart form body (ctx.http sends text).

import { ProviderError, type PluginContext } from "@scalius/plugin-sdk";

/** A text setting, trimmed; a missing one is a misconfiguration (the platform normally refuses the call first). */
export function requireText(ctx: PluginContext, key: string, label: string): string {
  const text = optionalText(ctx, key);
  if (!text) throw new ProviderError("misconfigured", `${label} is required.`, { code: "bangladesh.setting_missing" });
  return text;
}

export function optionalText(ctx: PluginContext, key: string): string | undefined {
  const value = ctx.settings[key];
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

/** The stable code of a platform refusal (`http.timeout`, `api.forbidden`), as the SDK runtime raises it. */
export function platformErrorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "";
}

/** A multipart/form-data body, as `FormData` sent it before the move (ctx.http bodies are text). */
export function multipartForm(fields: Array<[string, string]>): { contentType: string; body: string } {
  const boundary = `----ScaliusFormBoundary${crypto.randomUUID().replace(/-/g, "")}`;
  const parts = fields.map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: `${parts.join("")}--${boundary}--\r\n` };
}
