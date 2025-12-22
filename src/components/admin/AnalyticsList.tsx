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
import { formatDate } from "@/lib/utils";

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
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const formatType = (type: string) => {
    switch (type) {
      case "google_analytics":
        return "Google Analytics";
      case "facebook_pixel":
        return "Facebook Pixel";
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

  const handleDelete = async (id: string) => {
    try {
      setIsDeleting(true);
      const response = await fetch(`/api/analytics/${id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("Failed to delete analytics script");
      }

      // Reload the page to reflect changes
      window.location.reload();
    } catch (error) {
      console.error("Error deleting analytics script:", error);
      alert("Failed to delete analytics script. Please try again.");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleToggleActive = async (id: string, currentStatus: boolean) => {
    try {
      const response = await fetch(`/api/analytics/${id}/toggle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ isActive: !currentStatus }),
      });

      if (!response.ok) {
        throw new Error("Failed to toggle analytics script status");
      }

      // Reload the page to reflect changes
      window.location.reload();
    } catch (error) {
      console.error("Error toggling analytics script status:", error);
      alert("Failed to update analytics script status. Please try again.");
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
          <a href="/admin/analytics/new">
            <Plus className="mr-2 h-4 w-4" />
            Add Script
          </a>
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
              analytics.map((script) => (
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
                  <TableCell>{formatDate(script.createdAt)}</TableCell>
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
                        <a href={`/admin/analytics/${script.id}/edit`}>
                          <Edit className="h-4 w-4" />
                        </a>
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
      </CardContent>
    </Card>
  );
}
