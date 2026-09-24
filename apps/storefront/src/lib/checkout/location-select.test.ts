// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  enhanceLocationSelects,
  fetchLocationOptions,
  type LocationOption,
  type LocationSelection,
} from "./location-select";

// Mirrors the markup CheckoutLocationFields.astro renders on the server.
function renderFields(showArea = true): HTMLElement {
  document.body.innerHTML = `
    <div data-location-fields data-loading-text="Loading…">
      <select id="checkout-city" name="city" required>
        <option value="">Select a city</option>
        <option value="city_dhaka">Dhaka</option>
        <option value="city_ctg">Chattogram</option>
      </select>
      <select id="checkout-zone" name="zone" required disabled>
        <option value="">Select a zone</option>
      </select>
      <button type="button" hidden data-location-retry="zone">Retry zones</button>
      ${showArea ? `<select id="checkout-area" name="area" disabled><option value="">Select an area</option></select>
      <button type="button" hidden data-location-retry="area">Retry areas</button>` : ""}
      <input type="hidden" name="cityName" /><input type="hidden" name="zoneName" />
      ${showArea ? `<input type="hidden" name="areaName" />` : ""}
    </div>`;
  return document.querySelector<HTMLElement>("[data-location-fields]")!;
}

const select = (name: string) =>
  document.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!;
const hidden = (name: string) =>
  document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
const optionValues = (name: string) =>
  Array.from(select(name).options).map((option) => option.value);

function choose(name: string, value: string) {
  select(name).value = value;
  select(name).dispatchEvent(new Event("change", { bubbles: true }));
}

const ZONES: LocationOption[] = [
  { id: "zone_banani", name: "Banani" },
  { id: "zone_mirpur", name: "Mirpur" },
];
const AREAS: LocationOption[] = [{ id: "area_road_11", name: "Road 11" }];

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("enhanceLocationSelects", () => {
  it("lists thanas by name for people: case and creation order don't matter", async () => {
    const root = renderFields();
    const load = vi.fn(async () => [
      { id: "z_banani", name: "R3 Banani" },
      { id: "z_shampur", name: "shampur" },
      { id: "z_azampur", name: "azampur (Uttara)" },
      { id: "z_mirpur", name: "Mirpur" },
    ]);
    enhanceLocationSelects(root, { load });
    choose("city", "city_dhaka");
    await vi.waitFor(() => expect(select("zone").disabled).toBe(false));
    expect(Array.from(select("zone").options).slice(1).map((option) => option.text))
      .toEqual(["azampur (Uttara)", "Mirpur", "R3 Banani", "shampur"]);
  });

  it("forgets a thana the merchant removed: clears it, lists the rest, and reports the cleared address", async () => {
    const root = renderFields();
    let zones = ZONES;
    const load = vi.fn(async (level: string) => (level === "zones" ? zones : AREAS));
    const changes: LocationSelection[] = [];
    const controller = enhanceLocationSelects(root, { load, onChange: (s) => changes.push(s) })!;
    choose("city", "city_dhaka");
    await vi.waitFor(() => expect(select("zone").disabled).toBe(false));
    choose("zone", "zone_banani");
    await vi.waitFor(() => expect(select("area").disabled).toBe(false));

    zones = [{ id: "zone_mirpur", name: "Mirpur" }];
    await controller.forget("zone");

    expect(select("zone").value).toBe("");
    expect(optionValues("zone")).toEqual(["", "zone_mirpur"]);
    expect(select("area").disabled).toBe(true);
    expect(changes.at(-1)).toMatchObject({ cityId: "city_dhaka", zoneId: "", areaId: "" });
  });

  it("loads zones for the chosen city, then areas for the chosen zone", async () => {
    const root = renderFields();
    const load = vi.fn(async (level: string) => (level === "zones" ? ZONES : AREAS));
    const changes: LocationSelection[] = [];
    enhanceLocationSelects(root, { load, onChange: (s) => changes.push(s) });

    expect(select("zone").disabled).toBe(true);
    choose("city", "city_dhaka");
    expect(select("zone").getAttribute("aria-busy")).toBe("true");
    expect(select("zone").options[0].text).toBe("Loading…");
    await vi.waitFor(() => expect(select("zone").disabled).toBe(false));

    expect(load).toHaveBeenCalledWith("zones", "city_dhaka");
    expect(optionValues("zone")).toEqual(["", "zone_banani", "zone_mirpur"]);
    expect(select("zone").options[0].text).toBe("Select a zone");
    expect(hidden("cityName").value).toBe("Dhaka");

    choose("zone", "zone_mirpur");
    await vi.waitFor(() => expect(select("area").disabled).toBe(false));
    expect(load).toHaveBeenLastCalledWith("areas", "zone_mirpur");
    choose("area", "area_road_11");

    expect(changes.at(-1)).toEqual({
      cityId: "city_dhaka",
      cityName: "Dhaka",
      zoneId: "zone_mirpur",
      zoneName: "Mirpur",
      areaId: "area_road_11",
      areaName: "Road 11",
    });
    expect(hidden("areaName").value).toBe("Road 11");
  });

  it("clears dependent levels when the city changes and ignores stale zone responses", async () => {
    const root = renderFields();
    let resolveFirst!: (zones: LocationOption[]) => void;
    const load = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce([{ id: "zone_agrabad", name: "Agrabad" }]);
    enhanceLocationSelects(root, { load });

    choose("city", "city_dhaka");
    choose("city", "city_ctg");
    await vi.waitFor(() => expect(optionValues("zone")).toEqual(["", "zone_agrabad"]));
    resolveFirst(ZONES);
    await Promise.resolve();
    expect(optionValues("zone")).toEqual(["", "zone_agrabad"]);
    expect(select("area").disabled).toBe(true);
  });

  it("shows a retry control when a level fails to load and recovers on retry", async () => {
    const root = renderFields(false);
    const load = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(ZONES);
    enhanceLocationSelects(root, { load });
    const retry = document.querySelector<HTMLButtonElement>('[data-location-retry="zone"]')!;

    choose("city", "city_dhaka");
    await vi.waitFor(() => expect(retry.hidden).toBe(false));
    expect(select("zone").disabled).toBe(true);

    retry.click();
    await vi.waitFor(() => expect(select("zone").disabled).toBe(false));
    expect(retry.hidden).toBe(true);
    expect(optionValues("zone")).toEqual(["", "zone_banani", "zone_mirpur"]);
  });

  it("prefills a saved location by id or by display name", async () => {
    const root = renderFields();
    const load = vi.fn(async (level: string) => (level === "zones" ? ZONES : AREAS));
    const controller = enhanceLocationSelects(root, { load })!;

    await controller.prefill({ cityName: " dhaka ", zone: "zone_banani", areaName: "Road 11" });

    expect(controller.selection()).toEqual({
      cityId: "city_dhaka",
      cityName: "Dhaka",
      zoneId: "zone_banani",
      zoneName: "Banani",
      areaId: "area_road_11",
      areaName: "Road 11",
    });
  });
});

describe("fetchLocationOptions", () => {
  it("reads the enveloped public API list for the next level", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, data: [...ZONES, { id: 7 }] }), {
        status: 200,
      }),
    );
    await expect(
      fetchLocationOptions("https://api.example.test/api/v1", "zones", "city dhaka", fetchImpl),
    ).resolves.toEqual(ZONES);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example.test/api/v1/locations/zones?cityId=city%20dhaka",
      expect.anything(),
    );
  });

  it("returns null when the read fails so the page can offer a retry", async () => {
    const failing = vi.fn(async () => new Response("{}", { status: 503 }));
    await expect(fetchLocationOptions("", "areas", "zone_1", failing)).resolves.toBeNull();
    const throwing = vi.fn(async () => {
      throw new TypeError("offline");
    });
    await expect(fetchLocationOptions("", "areas", "zone_1", throwing)).resolves.toBeNull();
  });
});
