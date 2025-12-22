import { Hono } from "hono";
import { deleteCacheByPattern, getCacheStats } from "../utils/redis";
import { createResourceCachePattern } from "../middleware/cache";

// Create a Hono app for cache control routes
const app = new Hono();

// Get cache status and statistics
app.get("/stats", async (c) => {
  try {
    const stats = await getCacheStats();

    return c.json({
      success: true,
      stats,
    });
  } catch (error) {
    console.error("Error getting cache stats:", error);
    return c.json({ error: "Failed to get cache stats" }, 500);
  }
});

// Clear all cache
app.post("/clear", async (c) => {
  try {
    // Delete all API cache entries
    await deleteCacheByPattern("api:*");

    return c.json({
      success: true,
      message: "All cache cleared successfully",
    });
  } catch (error) {
    console.error("Error clearing cache:", error);
    return c.json({ error: "Failed to clear cache" }, 500);
  }
});

// Clear product cache
app.post("/clear-products", async (c) => {
  try {
    await deleteCacheByPattern(createResourceCachePattern("products"));

    return c.json({
      success: true,
      message: "Product cache cleared successfully",
    });
  } catch (error) {
    console.error("Error clearing product cache:", error);
    return c.json({ error: "Failed to clear product cache" }, 500);
  }
});

// Clear category cache
app.post("/clear-categories", async (c) => {
  try {
    await deleteCacheByPattern(createResourceCachePattern("categories"));

    return c.json({
      success: true,
      message: "Category cache cleared successfully",
    });
  } catch (error) {
    console.error("Error clearing category cache:", error);
    return c.json({ error: "Failed to clear category cache" }, 500);
  }
});

// Clear collections cache
app.post("/clear-collections", async (c) => {
  try {
    await deleteCacheByPattern(createResourceCachePattern("collections"));

    return c.json({
      success: true,
      message: "Collections cache cleared successfully",
    });
  } catch (error) {
    console.error("Error clearing collections cache:", error);
    return c.json({ error: "Failed to clear collections cache" }, 500);
  }
});

// Clear footer cache
app.post("/clear-footer", async (c) => {
  try {
    await deleteCacheByPattern(createResourceCachePattern("footer"));

    return c.json({
      success: true,
      message: "Footer cache cleared successfully",
    });
  } catch (error) {
    console.error("Error clearing footer cache:", error);
    return c.json({ error: "Failed to clear footer cache" }, 500);
  }
});

// Clear header cache
app.post("/clear-header", async (c) => {
  try {
    await deleteCacheByPattern(createResourceCachePattern("header"));

    return c.json({
      success: true,
      message: "Header cache cleared successfully",
    });
  } catch (error) {
    console.error("Error clearing header cache:", error);
    return c.json({ error: "Failed to clear header cache" }, 500);
  }
});

// Clear hero cache
app.post("/clear-hero", async (c) => {
  try {
    await deleteCacheByPattern(createResourceCachePattern("hero"));

    return c.json({
      success: true,
      message: "Hero cache cleared successfully",
    });
  } catch (error) {
    console.error("Error clearing hero cache:", error);
    return c.json({ error: "Failed to clear hero cache" }, 500);
  }
});

// Clear navigation cache
app.post("/clear-navigation", async (c) => {
  try {
    await deleteCacheByPattern(createResourceCachePattern("navigation"));

    return c.json({
      success: true,
      message: "Navigation cache cleared successfully",
    });
  } catch (error) {
    console.error("Error clearing navigation cache:", error);
    return c.json({ error: "Failed to clear navigation cache" }, 500);
  }
});

// Clear pages cache
app.post("/clear-pages", async (c) => {
  try {
    await deleteCacheByPattern(createResourceCachePattern("pages"));

    return c.json({
      success: true,
      message: "Pages cache cleared successfully",
    });
  } catch (error) {
    console.error("Error clearing pages cache:", error);
    return c.json({ error: "Failed to clear pages cache" }, 500);
  }
});

// Clear search cache
app.post("/clear-search", async (c) => {
  try {
    await deleteCacheByPattern(createResourceCachePattern("search"));

    return c.json({
      success: true,
      message: "Search cache cleared successfully",
    });
  } catch (error) {
    console.error("Error clearing search cache:", error);
    return c.json({ error: "Failed to clear search cache" }, 500);
  }
});

// Export the cache control routes
export { app as cacheControlRoutes };
