import React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import type { SubmitHandler } from "react-hook-form";
import { z } from "zod";
import { 
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../ui/form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Loader2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Textarea } from "../ui/textarea";

const analyticsFormSchema = z.object({
  id: z.string().optional(),
  name: z
    .string()
    .min(3, "Name must be at least 3 characters")
    .max(100, "Name must be less than 100 characters"),
  type: z.enum(["google_analytics", "facebook_pixel", "custom"]),
  isActive: z.boolean(),
  usePartytown: z.boolean(),
  config: z.string().min(1, "Configuration is required"),
  location: z.enum(["head", "body_start", "body_end"]),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});

type AnalyticsFormValues = z.infer<typeof analyticsFormSchema>;

interface AnalyticsFormProps {
  defaultValues?: Partial<AnalyticsFormValues>;
  isEdit?: boolean;
}

export function AnalyticsForm({
  defaultValues,
  isEdit = false,
}: AnalyticsFormProps) {
  const form = useForm<AnalyticsFormValues>({
    resolver: zodResolver(analyticsFormSchema),
    defaultValues: {
      name: "",
      type: "custom",
      isActive: true,
      usePartytown: true,
      config: "",
      location: "head",
      ...defaultValues,
    },
  });

  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const handleSubmit: SubmitHandler<AnalyticsFormValues> = async (values) => {
    try {
      setIsSubmitting(true);
      const endpoint = isEdit
        ? `/api/analytics/${values.id}`
        : "/api/analytics";
      const method = isEdit ? "PUT" : "POST";

      const response = await fetch(endpoint, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(values),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to save analytics script");
      }

      await response.json();
      window.location.href = "/admin/analytics";
    } catch (error) {
      console.error("Error submitting form:", error);
      alert("Failed to save analytics script. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Helper function to show example config based on type
  const getConfigExample = (type: string) => {
    switch (type) {
      case "google_analytics":
        return `<!-- Google Analytics -->
<script async src="https://www.googletagmanager.com/gtag/js?id=GA_MEASUREMENT_ID"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'GA_MEASUREMENT_ID');
</script>`;
      case "facebook_pixel":
        return `<!-- Facebook Pixel Code -->
<script>
  !function(f,b,e,v,n,t,s)
  {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};
  if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
  n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];
  s.parentNode.insertBefore(t,s)}(window, document,'script',
  'https://connect.facebook.net/en_US/fbevents.js');
  fbq('init', 'PIXEL_ID');
  fbq('track', 'PageView');
</script>`;
      default:
        return `<!-- Custom Script -->
<script>
  // Your custom script here
</script>`;
    }
  };

  // Update config example when type changes
  React.useEffect(() => {
    const subscription = form.watch((value, { name }) => {
      if (name === "type" && value.type) {
        const currentConfig = form.getValues("config");
        if (
          !currentConfig ||
          currentConfig === getConfigExample(form.getValues("type") as string)
        ) {
          form.setValue("config", getConfigExample(value.type as string), {
            shouldValidate: true,
          });
        }
      }
    });
    return () => subscription.unsubscribe();
  }, [form]);

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-8">
        <Card>
          <CardHeader>
            <CardTitle>Analytics Script</CardTitle>
            <CardDescription>
              Configure an analytics script to track user behavior on your site.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Google Analytics" {...field} />
                  </FormControl>
                  <FormDescription>
                    A descriptive name for this analytics script.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Type</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    defaultValue={field.value}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a script type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent className="rounded-xl bg-background">
                      <SelectItem value="google_analytics">
                        Google Analytics
                      </SelectItem>
                      <SelectItem value="facebook_pixel">
                        Facebook Pixel
                      </SelectItem>
                      <SelectItem value="custom">Custom Script</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    The type of analytics script you want to add.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="location"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Location</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    defaultValue={field.value}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a location" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent className="rounded-xl bg-background">
                      <SelectItem value="head">
                        Head (Before closing head tag)
                      </SelectItem>
                      <SelectItem value="body_start">
                        Body Start (After opening body tag)
                      </SelectItem>
                      <SelectItem value="body_end">
                        Body End (Before closing body tag)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Where in the HTML document to place this script.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="config"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Script Configuration</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Paste your script code here"
                      className="font-mono h-60"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    The actual script code that will be inserted into your site.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="isActive"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">Active Status</FormLabel>
                    <FormDescription>
                      Enable or disable this analytics script
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="usePartytown"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">Use Partytown</FormLabel>
                    <FormDescription>
                      Run this script in a web worker to improve page
                      performance
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isEdit ? "Update Analytics Script" : "Add Analytics Script"}
        </Button>
      </form>
    </Form>
  );
}
