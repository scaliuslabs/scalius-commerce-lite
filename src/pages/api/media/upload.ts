import type { APIRoute } from "astro";
import { db } from "../../../db";
import { media } from "../../../db/schema";
import { uploadFile } from "../../../lib/storage";
import { nanoid } from "nanoid";

const MAX_FILE_SIZE_MB = 10;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_FILES_PER_UPLOAD = 20;

// Process files in batches to avoid memory issues on Workers
const BATCH_SIZE = 5;

export const POST: APIRoute = async ({ request }) => {
  const startTime = Date.now();

  try {
    const formData = await request.formData();
    const files = formData.getAll("files") as File[];
    const folderId = (formData.get("folderId") as string) || null;

    // Validate file count
    if (!files.length) {
      return new Response(
        JSON.stringify({
          error: "No files provided",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    if (files.length > MAX_FILES_PER_UPLOAD) {
      return new Response(
        JSON.stringify({
          error: `Too many files. Maximum ${MAX_FILES_PER_UPLOAD} files allowed per upload. You tried to upload ${files.length} files.`,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    console.log(`Starting upload of ${files.length} file(s)`);

    const uploadedFiles = [];
    const errors: Array<{ filename: string; error: string; index: number }> = [];
    const now = new Date();

    // Process files in batches to avoid memory issues
    for (let batchStart = 0; batchStart < files.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, files.length);
      const batch = files.slice(batchStart, batchEnd);

      console.log(`Processing batch ${Math.floor(batchStart / BATCH_SIZE) + 1}: files ${batchStart + 1}-${batchEnd}`);

      // Process each file in the batch
      for (let i = 0; i < batch.length; i++) {
        const file = batch[i];
        const fileIndex = batchStart + i;

        try {
          console.log(`[${fileIndex + 1}/${files.length}] Uploading "${file.name}" (${(file.size / 1024).toFixed(2)}KB, ${file.type})`);

          // Basic validation before attempting upload
          if (!file.name || file.name.trim() === "") {
            errors.push({
              filename: file.name || `File ${fileIndex + 1}`,
              error: "Invalid file name",
              index: fileIndex,
            });
            continue;
          }

          if (file.size === 0) {
            errors.push({
              filename: file.name,
              error: "File is empty (0 bytes)",
              index: fileIndex,
            });
            continue;
          }

          if (file.size > MAX_FILE_SIZE_BYTES) {
            const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
            errors.push({
              filename: file.name,
              error: `File size (${fileSizeMB}MB) exceeds maximum allowed size (${MAX_FILE_SIZE_MB}MB)`,
              index: fileIndex,
            });
            continue;
          }

          // Upload to R2 (with validation, retry logic, etc. handled in storage layer)
          const uploadResult = await uploadFile(file);
          console.log(`[${fileIndex + 1}/${files.length}] Upload successful: ${uploadResult.url}`);

          // Save to database
          const [mediaFile] = await db
            .insert(media)
            .values({
              id: "media_" + nanoid(),
              filename: uploadResult.filename,
              url: uploadResult.url,
              size: uploadResult.size,
              mimeType: uploadResult.mimeType,
              folderId: folderId || null,
              createdAt: now,
              updatedAt: now,
            })
            .returning();

          uploadedFiles.push({
            id: mediaFile.id,
            url: mediaFile.url,
            filename: mediaFile.filename,
            size: mediaFile.size,
            mimeType: mediaFile.mimeType,
            createdAt: now,
          });
        } catch (fileError: any) {
          console.error(`[${fileIndex + 1}/${files.length}] Error uploading file "${file.name}":`, fileError);

          // Extract meaningful error message
          let errorMessage = fileError.message || "Upload failed for unknown reason";

          // Remove technical details from user-facing message
          if (errorMessage.includes("Deserialization error")) {
            errorMessage = "File processing error - the file may be corrupted or in an unsupported format";
          }

          errors.push({
            filename: file.name,
            error: errorMessage,
            index: fileIndex,
          });
        }
      }

      // Small delay between batches to give Workers time to breathe
      if (batchEnd < files.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    const duration = Date.now() - startTime;
    console.log(`Upload complete: ${uploadedFiles.length} succeeded, ${errors.length} failed (${duration}ms)`);

    // If all files failed, return error
    if (uploadedFiles.length === 0 && errors.length > 0) {
      return new Response(
        JSON.stringify({
          error: "All files failed to upload",
          details: errors.map(e => ({ filename: e.filename, error: e.error })),
          summary: `0 files uploaded, ${errors.length} files failed`,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Return results with partial success if applicable
    const response: any = {
      files: uploadedFiles,
      summary: errors.length === 0
        ? `Successfully uploaded ${uploadedFiles.length} file(s)`
        : `${uploadedFiles.length} file(s) uploaded successfully, ${errors.length} file(s) failed`,
    };

    if (errors.length > 0) {
      response.warnings = errors.map(e => ({ filename: e.filename, error: e.error }));
    }

    return new Response(
      JSON.stringify(response),
      {
        status: errors.length > 0 ? 207 : 201, // 207 Multi-Status for partial success
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.error(`Critical error uploading files (${duration}ms):`, error);

    // Ensure we always return a valid JSON response
    const errorMessage = error?.message || "Failed to upload files";
    return new Response(
      JSON.stringify({
        error: "Upload failed",
        details: errorMessage,
        summary: "An unexpected error occurred during upload. Please try again with fewer files or smaller file sizes.",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};
