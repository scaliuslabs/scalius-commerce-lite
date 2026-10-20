// Registry downloads follow redirects themselves, so every hop passes the
// outbound-URL guard: a public registry cannot bounce the Worker to a private
// or plain-http address (audit R2 F11).
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRegistryIndex } from "./releases";

afterEach(() => vi.unstubAllGlobals());

function redirect(location: string) {
  return new Response(null, { status: 302, headers: { Location: location } });
}

describe("registry downloads and redirects", () => {
  it("never follows a redirect to an address the outbound guard refuses", async () => {
    for (const location of ["http://registry.example.com/index.json", "https://127.0.0.1/index.json", "https://169.254.169.254/latest"]) {
      const fetch = vi.fn(async () => redirect(location));
      vi.stubGlobal("fetch", fetch);
      await expect(fetchRegistryIndex("https://registry.example.com/index.json")).rejects.toThrow(/public https/);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect((fetch.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: "manual" });
    }
  });

  it("follows a few public https redirects, then gives up", async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith("/final.json")
      ? new Response("not json", { status: 200 })
      : redirect("/final.json"));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchRegistryIndex("https://registry.example.com/index.json")).rejects.toMatchObject({ message: "The registry index is not JSON." });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://registry.example.com/index.json", "https://registry.example.com/final.json"]);

    const loop = vi.fn(async () => redirect("https://registry.example.com/again"));
    vi.stubGlobal("fetch", loop);
    await expect(fetchRegistryIndex("https://registry.example.com/index.json")).rejects.toThrow(/too many times/);
    expect(loop).toHaveBeenCalledTimes(4);
  });
});
