// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FormProvider, useForm } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomerFormValues } from "~/lib/form-schemas";

const getDeliveryLocations = vi.hoisted(() => vi.fn());

vi.mock("~/lib/api-functions/delivery", () => ({
  getDeliveryLocations,
}));

import { LocationSelector } from "./LocationSelector";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const locations = {
  city: [{ id: "city_1", name: "Dhaka", type: "city" }],
  zone: [{ id: "zone_1", name: "Dhanmondi", type: "zone" }],
  area: [{ id: "area_1", name: "Road 12", type: "area" }],
};

function LocationHarness() {
  const form = useForm<CustomerFormValues>({
    defaultValues: {
      name: "Customer QA",
      email: null,
      phone: "+8801712345678",
      address: null,
      city: "city_1",
      zone: "zone_1",
      area: "area_1",
      cityName: "Dhaka",
      zoneName: "Dhanmondi",
      areaName: "Road 12",
    },
  });

  return (
    <FormProvider {...form}>
      <LocationSelector />
    </FormProvider>
  );
}

describe("LocationSelector", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    getDeliveryLocations.mockImplementation(
      ({ data }: { data: { type: keyof typeof locations } }) =>
        Promise.resolve({ locations: locations[data.type] }),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  it("loads each level once for an existing address and keeps every level optional", async () => {
    await act(async () => root.render(<LocationHarness />));

    await vi.waitFor(() => {
      expect(getDeliveryLocations).toHaveBeenCalledTimes(3);
    });

    expect(
      getDeliveryLocations.mock.calls.map(([request]) => request.data),
    ).toEqual([
      { type: "city" },
      { type: "zone", parentId: "city_1" },
      { type: "area", parentId: "zone_1" },
    ]);
    expect(
      Array.from(host.querySelectorAll("label"), (label) => label.textContent),
    ).toEqual(["City", "Zone", "Area"]);
    expect(
      Array.from(host.querySelectorAll("button"), (button) => button.className),
    ).toEqual(expect.arrayContaining([expect.stringContaining("h-11")]));
  });
});
