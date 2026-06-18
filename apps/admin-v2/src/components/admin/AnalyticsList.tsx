import React from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../ui/alert-dialog";
import { Edit, Trash2, Plus, Power, PowerOff } from "lucide-react";
import { formatDate } from "@scalius/shared/utils";
import { toast } from "sonner";
import { getServerFnError } from "@/lib/api-helpers";
import {
  deleteAnalyticsScript,
  toggleAnalyticsScript,
} from "@/lib/api-functions/analytics";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter, Link } from "@tanstack/react-router";
import { AdminListPagination } from "./shared/AdminListPagination";
import { useDeleteHandler } from "@/hooks/use-delete-handler";

interface Analytics {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  usePartytown?: boolean;
  location: string;
  createdAt: string | number | Date;
  updatedAt: string | number | Date;
}

interface AnalyticsListProps {
  analytics: Analytics[];
}

export function AnalyticsList({ analytics }: AnalyticsListProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { isDeleting, handleDelete } = useDeleteHandler({
    deleteFn: (data) => deleteAnalyticsScript({ data }),
    invalidateKeys: [["analytics", "list"]],
    removeKeys: [(id) => ["analytics", "detail", id]],
    successMessage: "Analytics script has been deleted.",
    errorMessage: "Failed to delete analytics script.",
    invalidateRouter: true,
  });
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [currentPage, setCurrentPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(10);

  const totalPages = Math.max(1, Math.ceil(analytics.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);

  React.useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const paginatedAnalytics = React.useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return analytics.slice(start, start + pageSize);
  }, [analytics, safePage, pageSize]);

  const formatType = (type: string) => {
    switch (type) {
      case "google_analytics":
        return "Google Analytics";
      case "facebook_pixel":
        return "Facebook Pixel";
      case "cloudflare_web_analytics":
        return "Cloudflare Web Analytics";
      case "custom":
        return "Custom Script";
      default:
        return type;
    }
  };

  const formatLocation = (location: string) => {
    switch (location) {
      case "head":
        return "Head";
      case "body_start":
        return "Body Start";
      case "body_end":
        return "Body End";
      default:
        return location;
    }
  };

  const handleToggleActive = async (id: string, currentStatus: boolean) => {
    try {
      await toggleAnalyticsScript({ data: { id, isActive: !currentStatus } });
      queryClient.invalidateQueries({ queryKey: ["analytics", "list"] });
      queryClient.invalidateQueries({ queryKey: ["analytics", "detail", id] });
      toast.success("Updated", { description: "Analytics script status has been updated." });
      router.invalidate();
    } catch (error: unknown) {
      console.error("Error toggling analytics script status:", error);
      toast.error("Error", { description: getServerFnError(error, "Failed to update analytics script status.") });
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Analytics Scripts</CardTitle>
          <CardDescription>
            Manage analytics and tracking scripts for your site.
          </CardDescription>
        </div>
        <Button asChild>
          <Link to="/admin/analytics/new">
            <Plus className="mr-2 h-4 w-4" />
            Add Script
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {analytics.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8">
                  No analytics scripts found. Add your first script to start
                  tracking.
                </TableCell>
              </TableRow>
            ) : (
              paginatedAnalytics.map((script) => (
                <TableRow key={script.id}>
                  <TableCell className="font-medium">{script.name}</TableCell>
                  <TableCell>{formatType(script.type)}</TableCell>
                  <TableCell>{formatLocation(script.location)}</TableCell>
                  <TableCell>
                    <Badge
                      variant={script.isActive ? "default" : "secondary"}
                      className="capitalize"
                    >
                      {script.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span suppressHydrationWarning>{formatDate(script.createdAt)}</span>
                  </TableCell>
                  <TableCell>
                    <div className="flex space-x-2">
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() =>
                          handleToggleActive(script.id, script.isActive)
                        }
                        title={
                          script.isActive
                            ? "Deactivate script"
                            : "Activate script"
                        }
                      >
                        {script.isActive ? (
                          <PowerOff className="h-4 w-4" />
                        ) : (
                          <Power className="h-4 w-4" />
                        )}
                      </Button>
                      <Button variant="outline" size="icon" asChild>
                        <Link to={`/admin/analytics/${script.id}/edit` as string}>
                          <Edit className="h-4 w-4" />
                        </Link>
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={() => setSelectedId(script.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              Delete Analytics Script
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              Are you sure you want to delete this analytics
                              script? This action cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => {
                                if (selectedId) {
                                  handleDelete(selectedId);
                                }
                              }}
                              disabled={isDeleting}
                            >
                              {isDeleting ? "Deleting..." : "Delete"}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        {analytics.length > 0 && (
          <AdminListPagination
            pagination={{
              total: analytics.length,
              page: safePage,
              limit: pageSize,
              totalPages,
            }}
            itemLabel="scripts"
            onPageChange={setCurrentPage}
            onLimitChange={(nextLimit) => {
              setPageSize(nextLimit);
              setCurrentPage(1);
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}
