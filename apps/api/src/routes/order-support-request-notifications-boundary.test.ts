import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const API_SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

function readApiSource(path: string) {
  return readFileSync(join(API_SRC_ROOT, path), "utf8");
}

describe("order support request notification route boundaries", () => {
  it("enqueues support request lifecycle notifications through the durable order notification outbox helper", () => {
    const customerAuthSource = readApiSource("routes/customer-auth.ts");
    const adminSupportSource = readApiSource("routes/admin/orders-support-requests.ts");
    const queueHelperSource = readApiSource("utils/order-notification-queue.ts");

    expect(queueHelperSource).toContain("enqueueOrderSupportRequestNotificationForOrder");
    expect(queueHelperSource).toContain("support_request_submitted");
    expect(queueHelperSource).toContain("support_request_status_updated");
    expect(queueHelperSource).toContain("supportRequestId: options.requestId");

    expect(customerAuthSource).toContain("enqueueOrderSupportRequestNotificationForOrder");
    expect(customerAuthSource).toContain('notificationType: "support_request_submitted"');
    expect(customerAuthSource).toContain("getOrderSupportRequestStatusLabel(result.request.status)");

    expect(adminSupportSource).toContain("if (result.statusChanged)");
    expect(adminSupportSource).toContain('notificationType: "support_request_status_updated"');
    expect(adminSupportSource).toContain("getOrderSupportRequestStatusLabel(result.newStatus)");
    expect(adminSupportSource).toContain("request: result.request");
    expect(adminSupportSource).toContain("supportRequests: result.supportRequests");
    expect(adminSupportSource).not.toContain("return ok(c, result)");
  });
});
