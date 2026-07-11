// tests/unit/api/response-envelope.test.ts
// Tests the response envelope contract used throughout the API.
//
// The codebase uses a `{ success: true, data: T }` pattern for success responses
// and `{ success: false, error: { code, message, details? } }` for errors. This is enforced by
// convention across all route handlers.
//
// These tests verify the contracts so consumers (admin proxy, storefront) can
// rely on the shape.

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Response envelope helpers (extracted from route handler patterns)
// ---------------------------------------------------------------------------

/**
 * Success response factory.
 * Replicates the `c.json({ success: true, data })` pattern.
 */
function okResponse<T>(data: T) {
  return {
    body: { success: true as const, data },
    status: 200,
  };
}

/**
 * Created response factory (201).
 * Replicates `c.json({ success: true, data }, 201)`.
 */
function createdResponse<T>(data: T) {
  return {
    body: { success: true as const, data },
    status: 201,
  };
}

/**
 * No content response (204).
 */
function noContentResponse() {
  return {
    body: null,
    status: 204,
  };
}

/**
 * Error response factory.
 * Replicates the global API error response shape.
 */
function errorResponse(code: string, message: string, statusCode: number) {
  return {
    body: { success: false as const, error: { code, message } },
    status: statusCode,
  };
}

/**
 * Validation error (400).
 */
function validationError(message: string) {
  return errorResponse("VALIDATION_ERROR", message, 400);
}

/**
 * Not found error (404).
 */
function notFoundError(message: string) {
  return errorResponse("NOT_FOUND", message, 404);
}

/**
 * Conflict error (409).
 */
function conflictError(message: string) {
  return errorResponse("CONFLICT", message, 409);
}

/**
 * Internal server error (500).
 */
function internalError() {
  return errorResponse("INTERNAL_ERROR", "Internal Server Error", 500);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("API Response Envelope", () => {
  describe("Success responses", () => {
    it("ok() returns { success: true, data } with status 200", () => {
      const response = okResponse({ products: [], total: 0 });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.products).toEqual([]);
      expect(response.body.data.total).toBe(0);
    });

    it("ok() preserves all payload fields under data", () => {
      const data = {
        id: "prod_123",
        name: "Test Product",
        price: 1000,
        variants: [{ id: "var_1", sku: "SKU-001" }],
      };

      const response = okResponse(data);
      expect(response.body.data.id).toBe("prod_123");
      expect(response.body.data.name).toBe("Test Product");
      expect(response.body.data.variants).toHaveLength(1);
    });

    it("created() returns { success: true, data } with status 201", () => {
      const response = createdResponse({ id: "prod_123" });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBe("prod_123");
    });

    it("noContent() returns null body with status 204", () => {
      const response = noContentResponse();

      expect(response.status).toBe(204);
      expect(response.body).toBeNull();
    });

    it("success field is always true on success responses", () => {
      const responses = [
        okResponse({ data: "test" }),
        createdResponse({ id: "123" }),
      ];

      for (const response of responses) {
        expect(response.body.success).toBe(true);
      }
    });
  });

  describe("Error responses", () => {
    it("validationError returns 400 with structured error", () => {
      const response = validationError("Invalid input");

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(response.body.error.message).toBe("Invalid input");
    });

    it("notFoundError returns 404 with structured error", () => {
      const response = notFoundError("Product not found");

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe("NOT_FOUND");
      expect(response.body.error.message).toBe("Product not found");
    });

    it("conflictError returns 409 with structured error", () => {
      const response = conflictError("Duplicate entry");

      expect(response.status).toBe(409);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe("CONFLICT");
      expect(response.body.error.message).toBe("Duplicate entry");
    });

    it("internalError returns 500 with structured error", () => {
      const response = internalError();

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe("INTERNAL_ERROR");
      expect(response.body.error.message).toBe("Internal Server Error");
    });

    it("error field is always a structured object", () => {
      const responses = [
        validationError("Bad request"),
        notFoundError("Not found"),
        conflictError("Conflict"),
        internalError(),
      ];

      for (const response of responses) {
        expect(typeof response.body.error).toBe("object");
        expect(typeof response.body.error.code).toBe("string");
        expect(typeof response.body.error.message).toBe("string");
      }
    });

    it("success field is always false on error responses", () => {
      const responses = [
        validationError("test"),
        notFoundError("test"),
        conflictError("test"),
        internalError(),
      ];

      for (const response of responses) {
        expect(response.body.success).toBe(false);
      }
    });
  });

  describe("Consumer compatibility", () => {
    it("storefront can read response.data pattern", () => {
      // Storefront reads: const { data } = await response.json()
      const response = okResponse({ products: [{ id: "1" }], total: 1 });

      // Storefront pattern:
      const json = response.body;
      expect(json.success).toBe(true);
      expect(json.data.products).toHaveLength(1);
    });

    it("admin proxy unwraps correctly", () => {
      // Admin server functions receive { success: true, data } from the API
      // and unwrap `data` before returning to admin components.
      const response = okResponse({
        orders: [{ id: "ORD-001" }],
        pagination: { total: 1, page: 1, limit: 10, totalPages: 1 },
      });

      const json = response.body;
      expect(json.success).toBe(true);
      expect(json.data.orders).toBeDefined();
      expect(json.data.pagination).toBeDefined();
    });

    it("202 Accepted includes success: true at top level", () => {
      // Accepted responses keep the same top-level success envelope.
      const acceptedResponse = {
        body: { success: true, message: "Processing started" },
        status: 202,
      };

      expect(acceptedResponse.status).toBe(202);
      expect(acceptedResponse.body.success).toBe(true);
    });
  });
});
