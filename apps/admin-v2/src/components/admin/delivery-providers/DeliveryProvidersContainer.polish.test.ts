import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DELIVERY_PROVIDER_ENDPOINTS,
  getDeliveryProviderEnvironment,
  updateDeliveryProviderCredential,
  type DeliveryProviderDraft,
} from "./DeliveryProvidersContainer";

function source(name: string): string {
  return readFileSync(new URL(name, import.meta.url), "utf8");
}

describe("delivery provider workspace polish", () => {
  it("protects credential drafts and prevents internal selection loss", () => {
    const container = source("./DeliveryProvidersContainer.tsx");
    const sidebar = source("./ProviderListSidebar.tsx");

    expect(container).toContain("const isDraftDirty =");
    expect(container).toContain("<UnsavedChangesGuard");
    expect(container).toContain("isDirty={isDraftDirty}");
    expect(container).toContain("selectionDisabled={isEditing}");
    expect(sidebar).toContain("disabled={selectionDisabled}");
    expect(sidebar).toContain("aria-current=");
  });

  it("keeps the provider editor compact and phone-operable", () => {
    const sidebar = source("./ProviderListSidebar.tsx");
    const detail = source("./ProviderDetailPanel.tsx");

    expect(sidebar).not.toContain("Supported Providers");
    expect(detail).toContain("Basic information");
    expect(detail).toContain("Provider settings");
    expect(detail).toContain("Test credentials");
    expect(detail).toContain("[&_input]:min-h-11");
    expect(detail).toContain("min-h-11 sm:min-h-9");
  });

  it("keeps courier environments explicit and clears mismatched draft credentials", () => {
    const container = source("./DeliveryProvidersContainer.tsx");
    const detail = source("./ProviderDetailPanel.tsx");

    expect(container).toContain('sandbox: "https://courier-api-sandbox.pathao.com"');
    expect(container).toContain('production: "https://api-hermes.pathao.com"');
    expect(container).toContain('production: "https://portal.packzy.com/api/v1"');
    expect(container).toContain('["clientId", "clientSecret", "username", "password"]');
    expect(container).toContain('config.storeId = ""');
    expect(detail).toContain('formData.type === "pathao" && <SelectItem value="sandbox">Sandbox</SelectItem>');
    expect(detail).toContain('htmlFor="provider-environment"');
    expect(detail).toContain('id="provider-base-url"');
    expect(detail).toContain("Production API only.");
    expect(detail).toContain("Changes apply when saved");
    expect(detail).not.toContain("Steadfast Sandbox");
  });

  it("classifies endpoints and clears credentials that belong to another environment", () => {
    expect(getDeliveryProviderEnvironment("pathao", `${DELIVERY_PROVIDER_ENDPOINTS.pathao.sandbox}/`)).toBe("sandbox");
    expect(getDeliveryProviderEnvironment("steadfast", "https://proxy.example.test")).toBe("custom");

    const draft: DeliveryProviderDraft = {
      id: "provider-1",
      name: "Pathao",
      type: "pathao",
      credentials: JSON.stringify({
        baseUrl: DELIVERY_PROVIDER_ENDPOINTS.pathao.production,
        clientId: "client",
        clientSecret: "secret",
        username: "user",
        password: "password",
        webhookSecret: "keep-webhook",
      }),
      config: JSON.stringify({ storeId: "123", defaultDeliveryType: 48 }),
      isActive: true,
      readiness: null,
    };

    const updated = updateDeliveryProviderCredential(
      draft,
      "baseUrl",
      DELIVERY_PROVIDER_ENDPOINTS.pathao.sandbox,
    );
    expect(JSON.parse(updated.credentials)).toEqual({
      baseUrl: DELIVERY_PROVIDER_ENDPOINTS.pathao.sandbox,
      clientId: "",
      clientSecret: "",
      username: "",
      password: "",
      webhookSecret: "keep-webhook",
    });
    expect(JSON.parse(updated.config).storeId).toBe("");
    expect(updated.readiness).toBeNull();
  });
});
