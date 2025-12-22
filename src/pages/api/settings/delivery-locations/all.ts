import type { APIRoute } from "astro";
import { db } from "@/db";
import { deliveryLocations } from "@/db/schema";

// DELETE /api/settings/delivery-locations/all - Soft delete all locations
export const DELETE: APIRoute = async () => {
  try {
    // Perform a hard delete of all records in the deliveryLocations table
    await db.delete(deliveryLocations);

    return new Response(
      JSON.stringify({
        success: true,
        message: "All delivery locations have been permanently deleted.",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error cleaning all delivery locations:", error);
    return new Response(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : "Failed to clean all delivery locations",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
