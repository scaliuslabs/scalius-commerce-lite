import type { APIRoute } from "astro";
import { db } from "@/db";
import { checkoutLanguages } from "@/db/schema";
import { sql, eq, and, isNull, desc } from "drizzle-orm";
import { z } from "zod";

// Zod schema for updating a checkout language
const updateCheckoutLanguageSchema = z.object({
  name: z.string().min(1, "Name is required").max(100).optional(),
  code: z.string().min(1, "Code is required").max(10).optional(),
  languageData: z.object({}).passthrough().optional(),
  fieldVisibility: z.object({}).passthrough().optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

// GET: Fetch a specific checkout language by ID or all if ID is not provided (for trashed items view mainly)
export const GET: APIRoute = async ({ params, url }) => {
  const id = params.id;
  const showTrashedOnly = url.searchParams.get("trashed") === "true";

  try {
    if (id) {
      const language = await db
        .select()
        .from(checkoutLanguages)
        .where(eq(checkoutLanguages.id, id)) // Fetch by ID regardless of deletedAt for direct access
        .get();

      if (!language) {
        return new Response(
          JSON.stringify({ error: "Checkout language not found" }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      // Parse JSON fields for easier frontend consumption
      const parsedLanguage = {
        ...language,
        languageData: JSON.parse(language.languageData),
        fieldVisibility: JSON.parse(language.fieldVisibility),
      };
      return new Response(JSON.stringify({ data: parsedLanguage }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } else if (showTrashedOnly) {
      // This part is more for listing, might be better in index.ts, but kept for potential direct calls
      const languages = await db
        .select()
        .from(checkoutLanguages)
        .where(sql`${checkoutLanguages.deletedAt} IS NOT NULL`)
        .orderBy(desc(checkoutLanguages.deletedAt))
        .all();

      const parsedLanguages = languages.map((lang) => ({
        ...lang,
        languageData: JSON.parse(lang.languageData),
        fieldVisibility: JSON.parse(lang.fieldVisibility),
      }));

      return new Response(JSON.stringify({ data: parsedLanguages }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } else {
      return new Response(
        JSON.stringify({
          error: "ID is required or trashed=true param for listing",
        }),
        {
          status: 400,
        },
      );
    }
  } catch (error) {
    console.error(`Error fetching checkout language(s):`, error);
    return new Response(
      JSON.stringify({ error: "Failed to fetch checkout language(s)" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};

// PUT: Update a specific checkout language
export const PUT: APIRoute = async ({ params, request }) => {
  const id = params.id;
  if (!id) {
    return new Response(JSON.stringify({ error: "ID is required" }), {
      status: 400,
    });
  }

  try {
    const body = await request.json();
    const validation = updateCheckoutLanguageSchema.safeParse(body);

    if (!validation.success) {
      return new Response(
        JSON.stringify({
          error: "Invalid input",
          details: validation.error.flatten(),
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const currentLanguage = await db
      .select()
      .from(checkoutLanguages)
      .where(eq(checkoutLanguages.id, id))
      .get();

    if (!currentLanguage) {
      return new Response(
        JSON.stringify({ error: "Checkout language not found" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // If code is being changed, check if the new code already exists (and is not deleted, unless it's the current one being reactivated)
    if (validation.data.code && validation.data.code !== currentLanguage.code) {
      const existingLanguageWithCode = await db
        .select()
        .from(checkoutLanguages)
        .where(
          and(
            eq(checkoutLanguages.code, validation.data.code),
            isNull(checkoutLanguages.deletedAt), // Only check against non-deleted active codes
            sql`${checkoutLanguages.id} != ${id}`, // Exclude the current language itself from this check
          ),
        )
        .get();
      if (existingLanguageWithCode) {
        return new Response(
          JSON.stringify({
            error: "A checkout language with this code already exists.",
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // If setting as active, deactivate all others (that are not deleted)
    if (validation.data.isActive === true) {
      await db
        .update(checkoutLanguages)
        .set({ isActive: false })
        .where(
          and(
            eq(checkoutLanguages.isActive, true),
            isNull(checkoutLanguages.deletedAt),
          ),
        );
    }

    // If setting as default, remove default from all others (that are not deleted)
    if (validation.data.isDefault === true) {
      await db
        .update(checkoutLanguages)
        .set({ isDefault: false })
        .where(
          and(
            eq(checkoutLanguages.isDefault, true),
            isNull(checkoutLanguages.deletedAt),
          ),
        );
    }

    // Prepare update data
    const updateData: any = {
      ...validation.data,
      updatedAt: sql`(cast(strftime('%s','now') as int))`,
    };

    // Stringify JSON fields if they exist
    if (validation.data.languageData) {
      updateData.languageData = JSON.stringify(validation.data.languageData);
    }
    if (validation.data.fieldVisibility) {
      updateData.fieldVisibility = JSON.stringify(
        validation.data.fieldVisibility,
      );
    }

    // If language was deleted and is now being updated (e.g. reactivated), clear deletedAt
    if (
      currentLanguage.deletedAt &&
      (validation.data.isActive ||
        validation.data.isDefault ||
        validation.data.name)
    ) {
      updateData.deletedAt = null;
    }

    const [updatedLanguage] = await db
      .update(checkoutLanguages)
      .set(updateData)
      .where(eq(checkoutLanguages.id, id))
      .returning();

    if (!updatedLanguage) {
      return new Response(
        JSON.stringify({
          error: "Checkout language not found or no changes made",
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return new Response(JSON.stringify({ data: updatedLanguage }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error(`Error updating checkout language ${id}:`, error);
    if (
      error instanceof Error &&
      error.message.includes(
        "UNIQUE constraint failed: checkout_languages.code",
      )
    ) {
      return new Response(
        JSON.stringify({
          error: "A checkout language with this code already exists.",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ error: "Failed to update checkout language" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};

// PATCH: Soft delete (move to trash) a checkout language
export const PATCH: APIRoute = async ({ params }) => {
  const id = params.id;
  if (!id) {
    return new Response(JSON.stringify({ error: "ID is required" }), {
      status: 400,
    });
  }

  try {
    const existingLanguage = await db
      .select({
        id: checkoutLanguages.id,
        isActive: checkoutLanguages.isActive,
        deletedAt: checkoutLanguages.deletedAt,
      })
      .from(checkoutLanguages)
      .where(eq(checkoutLanguages.id, id))
      .get();

    if (!existingLanguage) {
      return new Response(
        JSON.stringify({ error: "Checkout language not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }

    if (existingLanguage.deletedAt) {
      return new Response(
        JSON.stringify({ error: "Checkout language already in trash" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Prevent soft deletion of active language
    if (existingLanguage.isActive) {
      return new Response(
        JSON.stringify({
          error:
            "Cannot move active checkout language to trash. Please set another language as active first.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    await db
      .update(checkoutLanguages)
      .set({
        deletedAt: sql`(cast(strftime('%s','now') as int))`,
        isActive: false, // Ensure it's not active when soft deleted
        isDefault: false, // Ensure it's not default when soft deleted
      })
      .where(eq(checkoutLanguages.id, id));

    return new Response(JSON.stringify({ message: "Moved to trash" }), {
      status: 200,
    });
  } catch (error) {
    console.error(`Error moving checkout language ${id} to trash:`, error);
    return new Response(
      JSON.stringify({ error: "Failed to move checkout language to trash" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};

// DELETE: Permanently delete a checkout language
export const DELETE: APIRoute = async ({ params }) => {
  const id = params.id;
  if (!id) {
    return new Response(JSON.stringify({ error: "ID is required" }), {
      status: 400,
    });
  }

  try {
    const languageToDelete = await db
      .select({
        id: checkoutLanguages.id,
        isActive: checkoutLanguages.isActive,
      })
      .from(checkoutLanguages)
      .where(eq(checkoutLanguages.id, id))
      .get();

    if (!languageToDelete) {
      return new Response(
        JSON.stringify({ error: "Checkout language not found" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Optional: Prevent permanent deletion of active language, though typically one would soft delete first.
    // For now, we allow it, assuming admin knows what they are doing if they reach permanent delete.
    // if (languageToDelete.isActive) {
    //   return new Response(
    //     JSON.stringify({ error: "Cannot permanently delete an active language. Deactivate first." }),
    //     { status: 400, headers: { "Content-Type": "application/json" } },
    //   );
    // }

    await db.delete(checkoutLanguages).where(eq(checkoutLanguages.id, id));

    return new Response(null, { status: 204 }); // No content, successful deletion
  } catch (error) {
    console.error(`Error permanently deleting checkout language ${id}:`, error);
    return new Response(
      JSON.stringify({
        error: "Failed to permanently delete checkout language",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};
