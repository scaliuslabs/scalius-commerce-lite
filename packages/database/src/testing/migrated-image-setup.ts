/**
 * Vitest global setup: build the migrated D1 image once, before the test
 * processes start, so no test file pays for the migrations inside its first
 * test's time limit (`createMigratedSqlite` shares the image through a file).
 */
import { createMigratedSqlite } from "./sqlite-d1";

export default function setup(): void {
  createMigratedSqlite().close();
}
