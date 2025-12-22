import { useState, useEffect } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Button } from "../ui/button";
import {
  Trash2,
  RefreshCw,
  AlertCircle,
  Database,
  BarChart2,
  Layers,
  Server,
  Clock,
} from "lucide-react";
import { toast } from "sonner";
import { Progress } from "../ui/progress";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Separator } from "../ui/separator";

interface CacheStats {
  size: number;
  memory: string;
  hitRate?: string;
  missRate?: string;
  uptime: string;
}

const CACHE_TYPES = [
  { id: "products", name: "Products", icon: Layers },
  { id: "categories", name: "Categories", icon: Layers },
  { id: "collections", name: "Collections", icon: Layers },
  { id: "footer", name: "Footer", icon: Layers },
  { id: "header", name: "Header", icon: Layers },
  { id: "hero", name: "Hero Sliders", icon: Layers },
  { id: "navigation", name: "Navigation", icon: Layers },
  { id: "pages", name: "Pages", icon: Layers },
  { id: "search", name: "Search", icon: Layers },
];

export function CacheManager() {
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [clearingCache, setClearingCache] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    fetchCacheStats();
  }, []);

  const fetchCacheStats = async () => {
    try {
      setLoading(true);
      const response = await fetch("/api/settings/cache/stats");

      if (!response.ok) {
        throw new Error("Failed to fetch cache statistics");
      }

      const data = await response.json();
      setStats(data.stats);
      setLastUpdated(new Date());
    } catch (error) {
      console.error("Error fetching cache stats:", error);
      toast.error("Failed to fetch cache statistics");
    } finally {
      setLoading(false);
    }
  };

  const clearCache = async (cacheType: string) => {
    try {
      setClearingCache(cacheType);

      const endpoint =
        cacheType === "all"
          ? "/api/settings/cache/clear"
          : `/api/settings/cache/clear-${cacheType}`;

      const response = await fetch(endpoint, {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(`Failed to clear ${cacheType} cache`);
      }

      toast.success(
        `${cacheType === "all" ? "All" : CACHE_TYPES.find((t) => t.id === cacheType)?.name} cache cleared successfully`,
      );
      fetchCacheStats();
    } catch (error) {
      console.error(`Error clearing ${cacheType} cache:`, error);
      toast.error(`Failed to clear ${cacheType} cache`);
    } finally {
      setClearingCache(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center">
              <Database className="mr-2 h-5 w-5 text-primary" />
              Cache Status
            </CardTitle>
            <CardDescription>Current cache statistics</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">
                <div className="h-4 bg-gray-200 rounded animate-pulse" />
                <div className="h-4 bg-gray-200 rounded animate-pulse w-3/4" />
                <div className="h-4 bg-gray-200 rounded animate-pulse w-1/2" />
              </div>
            ) : stats ? (
              <div className="space-y-4">
                <div>
                  <div className="flex justify-between mb-1 text-sm">
                    <span className="text-muted-foreground">Cache Entries</span>
                    <span className="font-medium">{stats.size}</span>
                  </div>
                  <div className="flex justify-between mb-1 text-sm">
                    <span className="text-muted-foreground">Memory Usage</span>
                    <span className="font-medium">{stats.memory}</span>
                  </div>
                  {stats.hitRate && (
                    <div className="flex justify-between mb-1 text-sm">
                      <span className="text-muted-foreground">Hit Rate</span>
                      <span className="font-medium">{stats.hitRate}</span>
                    </div>
                  )}
                  {stats.missRate && (
                    <div className="flex justify-between mb-1 text-sm">
                      <span className="text-muted-foreground">Miss Rate</span>
                      <span className="font-medium">{stats.missRate}</span>
                    </div>
                  )}
                  <div className="flex justify-between mb-1 text-sm">
                    <span className="text-muted-foreground">Cache Uptime</span>
                    <span className="font-medium">{stats.uptime}</span>
                  </div>
                </div>

                {stats.hitRate && (
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">
                      Hit rate
                    </div>
                    <div className="relative">
                      <Progress
                        value={parseFloat(stats.hitRate)}
                        className="h-2"
                      />
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Stats unavailable</AlertTitle>
                <AlertDescription>
                  Unable to fetch cache statistics
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
          <CardFooter className="pt-1">
            <div className="w-full flex justify-between items-center">
              <div className="text-xs text-muted-foreground flex items-center">
                <Clock className="h-3 w-3 mr-1" />
                {lastUpdated
                  ? `Last updated: ${lastUpdated.toLocaleTimeString()}`
                  : "Never updated"}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={fetchCacheStats}
                disabled={loading}
              >
                <RefreshCw
                  className={`mr-2 h-3 w-3 ${loading ? "animate-spin" : ""}`}
                />
                Refresh
              </Button>
            </div>
          </CardFooter>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center">
              <BarChart2 className="mr-2 h-5 w-5 text-primary" />
              Cache Performance
            </CardTitle>
            <CardDescription>
              Optimize your application's speed by managing cache resources
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-sm text-muted-foreground mb-4">
              <p>
                Cache is used to improve performance by storing frequently
                accessed data. Clearing cache can help refresh content but may
                temporarily increase load times.
              </p>
            </div>

            <div className="mb-4">
              <Button
                variant="destructive"
                onClick={() => clearCache("all")}
                disabled={clearingCache !== null}
                className="w-full"
              >
                {clearingCache === "all" ? (
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="mr-2 h-4 w-4" />
                )}
                Clear All Cache
              </Button>
            </div>

            <Separator className="my-4" />

            <div className="text-sm font-medium mb-2">
              Clear Individual Caches
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              {CACHE_TYPES.map((cacheType) => (
                <Button
                  key={cacheType.id}
                  variant="outline"
                  className="justify-start"
                  onClick={() => clearCache(cacheType.id)}
                  disabled={clearingCache !== null}
                >
                  {clearingCache === cacheType.id ? (
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <cacheType.icon className="mr-2 h-4 w-4" />
                  )}
                  {cacheType.name}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Server className="mr-2 h-5 w-5 text-primary" />
            Cache Management Tips
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4 text-sm">
            <div>
              <h4 className="font-medium">When to clear cache:</h4>
              <ul className="list-disc list-inside pl-4 mt-1 text-muted-foreground">
                <li>
                  After you've updated content that isn't showing the latest
                  changes
                </li>
                <li>When you see outdated information displayed to users</li>
                <li>During development when testing new features</li>
                <li>If you experience inconsistent behavior across the site</li>
              </ul>
            </div>
            <div>
              <h4 className="font-medium">Best practices:</h4>
              <ul className="list-disc list-inside pl-4 mt-1 text-muted-foreground">
                <li>
                  Clear only specific caches when possible instead of all cache
                </li>
                <li>
                  Schedule cache clearing during off-peak hours for production
                  sites
                </li>
                <li>Monitor cache hit rates to optimize caching policies</li>
                <li>
                  Consider increasing TTL (Time To Live) for rarely changing
                  content
                </li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
