// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FormProvider, useForm, type UseFormReturn } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomerFormValues } from "~/lib/customer-form-schema";

const getDeliveryLocations = vi.hoisted(() => vi.fn());

vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminSettingsDeliveryLocations: getDeliveryLocations,
}));

import { LocationSelector } from "./LocationSelector";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const places = {
  city: [
    { id: "city_1", name: "Dhaka", type: "city", parentPath: [] },
    { id: "city_2", name: "Chattogram", type: "city", parentPath: [] },
  ],
  zone: [{ id: "zone_1", name: "Dhanmondi", type: "zone", parentPath: ["Dhaka"] }],
  area: [{ id: "area_1", name: "Road 12", type: "area", parentPath: ["Dhanmondi", "Dhaka"] }],
};

let form: UseFormReturn<CustomerFormValues>;

function LocationHarness() {
  form = useForm<CustomerFormValues>({
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

  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const trigger = (label: string) => {
    const id = [...host.querySelectorAll("label")].find((node) => node.textContent === label)!.htmlFor;
    return document.getElementById(id) as HTMLButtonElement;
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    getDeliveryLocations.mockImplementation(({ query }: { query: { type: keyof typeof places } }) =>
      Promise.resolve({ locations: places[query.type], pagination: { total: places[query.type].length, page: 1, limit: 50, totalPages: 1 } }),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows a saved address without loading any list, and searches a level only when it opens", async () => {
    await act(async () => root.render(
      <QueryClientProvider client={new QueryClient()}>
        <LocationHarness />
      </QueryClientProvider>,
    ));

    expect([...host.querySelectorAll("label")].map((label) => label.textContent)).toEqual(["City", "Thana", "Area"]);
    expect(trigger("City").textContent).toContain("Dhaka");
    expect(trigger("Thana").textContent).toContain("Dhanmondi");
    expect(trigger("Area").textContent).toContain("Road 12");
    expect(getDeliveryLocations).not.toHaveBeenCalled();

    // Thanas: only the chosen city's, active ones, one page at a time.
    await act(async () => trigger("Thana").click());
    await settle();
    expect(getDeliveryLocations).toHaveBeenCalledWith(expect.objectContaining({
      query: { type: "zone", parentId: "city_1", isActive: "true", page: 1, limit: 50 },
    }));
    expect([...document.querySelectorAll('[role="option"]')].map((node) => node.textContent)).toEqual(["Dhanmondi · Dhaka"]);
  });

  it("clears the thana and area when the city changes, and lets every level be cleared", async () => {
    await act(async () => root.render(
      <QueryClientProvider client={new QueryClient()}>
        <LocationHarness />
      </QueryClientProvider>,
    ));

    await act(async () => trigger("City").click());
    await settle();
    const chattogram = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) => node.textContent === "Chattogram")!;
    await act(async () => chattogram.click());

    expect(form.getValues(["city", "cityName", "zone", "zoneName", "area", "areaName"])).toEqual([
      "city_2", "Chattogram", null, "", null, "",
    ]);
    expect(form.getFieldState("city").isDirty).toBe(true);
    expect(trigger("Thana").disabled).toBe(false);
    expect(trigger("Area").disabled).toBe(true);

    // The customer's address is optional: the city can be cleared too.
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Clear Chattogram"]')!.click());
    expect(form.getValues("city")).toBeNull();
    expect(trigger("Thana").disabled).toBe(true);
  });
});
