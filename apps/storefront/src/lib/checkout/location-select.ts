/**
 * City → thana → area pickers. The server renders native `<select>`s (every
 * city, and the thanas of a known city), which work without JavaScript; this
 * module turns each into a search-or-scroll combobox
 * (`location-combobox.ts`), fetches the next level when the buyer picks a
 * parent, and keeps the optional `cityName`/`zoneName`/`areaName` hidden
 * inputs in sync.
 */
import { enhanceLocationCombobox, type LocationCombobox } from "./location-combobox";

export interface LocationOption {
  id: string;
  name: string;
}

export interface LocationSelection {
  cityId: string;
  cityName: string;
  zoneId: string;
  zoneName: string;
  areaId: string;
  areaName: string;
}

export interface LocationPrefillDetail {
  city?: string | null;
  cityName?: string | null;
  zone?: string | null;
  zoneName?: string | null;
  area?: string | null;
  areaName?: string | null;
}

export type LocationLevel = "zones" | "areas";
export type LocationLoader = (
  level: LocationLevel,
  parentId: string,
) => Promise<LocationOption[] | null>;

function isLocationOption(value: unknown): value is LocationOption {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as LocationOption).id === "string" &&
    typeof (value as LocationOption).name === "string"
  );
}

/** Reads one location level from the public API; `null` means the read failed. */
export async function fetchLocationOptions(
  apiBaseUrl: string,
  level: LocationLevel,
  parentId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LocationOption[] | null> {
  const param = level === "zones" ? "cityId" : "zoneId";
  try {
    const response = await fetchImpl(
      `${apiBaseUrl}/locations/${level}?${param}=${encodeURIComponent(parentId)}`,
      { headers: { Accept: "application/json" } },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { success?: unknown; data?: unknown };
    return body.success === true && Array.isArray(body.data)
      ? body.data.filter(isLocationOption)
      : null;
  } catch {
    return null;
  }
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

/** Matches a saved id first, then a saved display name. */
export function resolveLocationOption<T extends LocationOption>(
  locations: readonly T[],
  idOrName?: string | null,
  displayName?: string | null,
): T | undefined {
  const candidates = [idOrName, displayName]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const exact = locations.find((location) => location.id === candidate);
    if (exact) return exact;
  }
  const names = new Set(candidates.map(normalizeName));
  return locations.find((location) => names.has(normalizeName(location.name)));
}

function optionsOf(select: HTMLSelectElement): LocationOption[] {
  return Array.from(select.options)
    .filter((option) => option.value)
    .map((option) => ({ id: option.value, name: option.text }));
}

function createOption(select: HTMLSelectElement, text: string, value: string) {
  const option = select.ownerDocument.createElement("option");
  option.value = value;
  option.textContent = text;
  return option;
}

function selectedName(select: HTMLSelectElement | null): string {
  const option = select ? select.options[select.selectedIndex] : undefined;
  return option?.value ? option.text : "";
}

export interface LocationSelectsController {
  selection(): LocationSelection;
  prefill(detail: LocationPrefillDetail): Promise<void>;
  /**
   * The chosen city, thana or area is gone: clear it (and what depends on
   * it) and list that level again without it.
   */
  forget(level: "city" | "zone" | "area"): Promise<void>;
}

/**
 * Wires `select[name=city|zone|area]` inside `root`. Retry buttons are
 * `[data-location-retry="zone"|"area"]`; the placeholder option of each child
 * select shows `data-loading-text` from `root` while its level loads. An area
 * level with no areas stays hidden (`[data-location-area]`). The combobox
 * copy comes from `root`'s `data-no-match-text` and
 * `data-close-text`.
 */
export function enhanceLocationSelects(
  root: ParentNode & { dataset?: DOMStringMap },
  options: {
    load: LocationLoader;
    onChange?: (selection: LocationSelection) => void;
    signal?: AbortSignal;
  },
): LocationSelectsController | null {
  const city = root.querySelector<HTMLSelectElement>('select[name="city"]');
  const zone = root.querySelector<HTMLSelectElement>('select[name="zone"]');
  const area = root.querySelector<HTMLSelectElement>('select[name="area"]');
  if (!city || !zone) return null;

  const loadingText = root.dataset?.loadingText || "";
  const requests = new WeakMap<HTMLSelectElement, number>();
  const placeholders = new WeakMap<HTMLSelectElement, string>();
  for (const select of [zone, area]) {
    if (select) placeholders.set(select, select.options[0]?.text ?? "");
  }

  const retryButton = (level: "zone" | "area") =>
    root.querySelector<HTMLElement>(`[data-location-retry="${level}"]`);
  const areaWrapper = root.querySelector<HTMLElement>("[data-location-area]");
  const comboboxCopy = {
    noMatchText: root.dataset?.noMatchText || "",
    closeText: root.dataset?.closeText || "",
  };
  const boxes = new Map<HTMLSelectElement, LocationCombobox>();
  for (const select of [city, zone, area]) {
    if (select) boxes.set(select, enhanceLocationCombobox(select, comboboxCopy, options.signal));
  }
  const sync = (select?: HTMLSelectElement | null) => {
    if (select) boxes.get(select)?.sync();
    else for (const box of boxes.values()) box.sync();
  };

  const selection = (): LocationSelection => ({
    cityId: city.value,
    cityName: selectedName(city),
    zoneId: zone.value,
    zoneName: selectedName(zone),
    areaId: area?.value ?? "",
    areaName: selectedName(area),
  });

  const notify = () => {
    const current = selection();
    for (const field of ["cityName", "zoneName", "areaName"] as const) {
      const input = root.querySelector<HTMLInputElement>(`input[name="${field}"]`);
      if (input) input.value = current[field];
    }
    sync();
    options.onChange?.(current);
  };

  const reset = (select: HTMLSelectElement | null, placeholder?: string) => {
    if (!select) return;
    if (select === area && areaWrapper) areaWrapper.hidden = true;
    requests.set(select, (requests.get(select) ?? 0) + 1);
    select.replaceChildren(
      createOption(select, placeholder ?? placeholders.get(select) ?? "", ""),
    );
    select.disabled = true;
    select.removeAttribute("aria-busy");
    const retry = retryButton(select === zone ? "zone" : "area");
    if (retry) retry.hidden = true;
    sync(select);
  };

  const load = async (
    select: HTMLSelectElement,
    level: LocationLevel,
    parentId: string,
  ): Promise<LocationOption[]> => {
    reset(select, loadingText || undefined);
    const request = requests.get(select) ?? 0;
    select.setAttribute("aria-busy", "true");
    sync(select);
    let result: LocationOption[] | null;
    try {
      result = await options.load(level, parentId);
    } catch {
      result = null;
    }
    if (requests.get(select) !== request) return [];
    select.removeAttribute("aria-busy");
    select.options[0].text = placeholders.get(select) ?? "";
    if (result === null) {
      const retry = retryButton(select === zone ? "zone" : "area");
      if (retry) retry.hidden = false;
      sync(select);
      return [];
    }
    // People look for a place by name: sort without regard to case, in the page's language.
    const collator = new Intl.Collator(select.ownerDocument.documentElement.lang || undefined, { sensitivity: "base", numeric: true });
    result = [...result].sort((left, right) => collator.compare(left.name, right.name));
    select.append(...result.map((item) => createOption(select, item.name, item.id)));
    select.disabled = result.length === 0;
    if (select === area && areaWrapper) areaWrapper.hidden = result.length === 0;
    sync(select);
    return result;
  };

  const onCity = () => {
    // The old zone and area belong to the old city: clear them before anyone
    // (the tax quote) hears about the change.
    reset(zone);
    reset(area);
    notify();
    if (city.value) void load(zone, "zones", city.value);
  };
  const onZone = () => {
    notify();
    if (!area) return;
    if (zone.value) void load(area, "areas", zone.value);
    else reset(area);
  };

  const listen = { signal: options.signal };
  // The buyer chose a city: the thana is next.
  city.addEventListener("change", () => {
    onCity();
    if (city.value) boxes.get(zone)?.focus();
  }, listen);
  zone.addEventListener("change", onZone, listen);
  area?.addEventListener("change", notify, listen);
  retryButton("zone")?.addEventListener(
    "click",
    () => city.value && void load(zone, "zones", city.value),
    listen,
  );
  retryButton("area")?.addEventListener(
    "click",
    () => area && zone.value && void load(area, "areas", zone.value),
    listen,
  );

  return {
    selection,
    async forget(level) {
      if (level === "city") {
        city.value = "";
        onCity();
        return;
      }
      if (level === "zone") {
        reset(area);
        if (!city.value) {
          reset(zone);
          notify();
          return;
        }
        const reloading = load(zone, "zones", city.value);
        notify();
        await reloading;
        return;
      }
      if (!area) return;
      if (!zone.value) {
        reset(area);
        notify();
        return;
      }
      const reloading = load(area, "areas", zone.value);
      notify();
      await reloading;
    },
    async prefill(detail) {
      const cityOption = resolveLocationOption(optionsOf(city), detail.city, detail.cityName);
      if (!cityOption) return;
      city.value = cityOption.id;
      reset(zone);
      reset(area);
      notify();
      const zones = await load(zone, "zones", cityOption.id);
      const zoneOption = resolveLocationOption(zones, detail.zone, detail.zoneName);
      if (!zoneOption) return;
      zone.value = zoneOption.id;
      notify();
      if (!area) return;
      const areas = await load(area, "areas", zoneOption.id);
      const areaOption = resolveLocationOption(areas, detail.area, detail.areaName);
      if (!areaOption) return;
      area.value = areaOption.id;
      notify();
    },
  };
}
