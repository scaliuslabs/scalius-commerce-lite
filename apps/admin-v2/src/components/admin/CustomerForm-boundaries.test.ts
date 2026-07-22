import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const customerFormSource = readFileSync(
  new URL("./CustomerForm.tsx", import.meta.url),
  "utf8",
);
const locationSelectorSource = readFileSync(
  new URL("./LocationSelector.tsx", import.meta.url),
  "utf8",
);

describe("customer form workflow boundaries", () => {
  it("keeps the saved customer in context instead of returning to the list", () => {
    expect(customerFormSource).toContain("onSuccess: (result) =>");
    expect(customerFormSource).toContain("form.reset({");
    expect(customerFormSource).toContain(
      'to: "/admin/customers/$customerId/edit"',
    );
    expect(customerFormSource).toContain("replace: true");
    expect(customerFormSource).not.toContain("setTimeout(");
    expect(customerFormSource).not.toContain("isInitializing");
  });

  it("marks only identity fields as required and preserves mobile-sized controls", () => {
    expect(customerFormSource).toMatch(/Name<span[^>]+> \*<\/span>/);
    expect(customerFormSource).toMatch(/Phone number<span[^>]+> \*<\/span>/);
    expect(customerFormSource.match(/\n\s+required\n/g)).toHaveLength(2);
    expect(customerFormSource.match(/\(required\)/g)).toHaveLength(2);
    expect(customerFormSource).not.toContain("Email (Optional)");
    expect(customerFormSource).not.toContain("Address (Optional)");
    expect(customerFormSource).toContain('className="h-11 sm:h-9"');

    for (const label of ["City", "Zone", "Area"]) {
      expect(locationSelectorSource).toContain(`<FormLabel>${label}</FormLabel>`);
    }
    expect(locationSelectorSource).not.toContain("text-red-500");
    expect(locationSelectorSource).toContain(
      'const selectTriggerClassName = "h-11 sm:h-9"',
    );
    expect(locationSelectorSource).not.toContain("Select a ");
    for (const placeholder of ["Select city", "Select zone", "Select area"]) {
      expect(locationSelectorSource).toContain(placeholder);
    }
  });

  it("turns duplicate-phone conflicts into a field error", () => {
    expect(customerFormSource).toContain("phone number already exists");
    expect(customerFormSource).toContain('form.setError("phone"');
    expect(customerFormSource).toContain("Phone number already in use");
  });
});
