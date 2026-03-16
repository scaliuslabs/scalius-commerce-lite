type FraudCheckerProvider = {
  id?: string;
  [key: string]: unknown;
};

type TestResult = {
  success: boolean;
  message?: string;
  [key: string]: unknown;
};

type FraudCheckerActionsType = {
  saveProvider(provider: FraudCheckerProvider): Promise<unknown>;
  deleteProvider(id: string): Promise<boolean>;
  testProvider(id: string): Promise<TestResult>;
};

type FraudCheckerWindow = Window & {
  fraudCheckerActions?: FraudCheckerActionsType;
};

export function initFraudCheckerActions(): void {
  const win = window as FraudCheckerWindow;

  win.fraudCheckerActions = {
    async saveProvider(provider) {
      try {
        const method = provider.id ? "PUT" : "POST";
        const response = await fetch("/api/v1/admin/fraud-checker", {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(provider),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Failed to save provider");
        }

        return response.json();
      } catch (error) {
        console.error("Error in saveProvider:", error);
        throw error;
      }
    },

    async deleteProvider(id) {
      try {
        const response = await fetch(
          `/api/v1/admin/settings/fraud-checker/${id}`,
          {
            method: "DELETE",
          }
        );

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Failed to delete provider");
        }

        return true;
      } catch (error) {
        console.error("Error in deleteProvider:", error);
        throw error;
      }
    },

    async testProvider(id) {
      try {
        const response = await fetch(
          `/api/v1/admin/settings/fraud-checker/${id}/test`,
          {
            method: "POST",
          }
        );

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({
            error: "Failed to parse error response",
          }));
          return {
            success: false,
            message:
              errorData.error || "Failed to test provider connection",
          };
        }

        return response.json();
      } catch (error) {
        console.error("Error in testProvider:", error);
        return {
          success: false,
          message:
            error instanceof Error
              ? error.message
              : "Failed to test provider",
        };
      }
    },
  };
}
