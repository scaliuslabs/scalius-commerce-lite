// src/server/openapi/auth-paths.ts
export const authPaths = {
  "/auth/token": {
    get: {
      tags: ["Auth"],
      summary: "Obtain a JWT for API access",
      description:
        "This endpoint is for machine-to-machine authentication. A client service must provide a pre-configured static API token in the `X-API-Token` header. In return, it receives a short-lived JSON Web Token (JWT) which must be used as a Bearer token for all subsequent requests to protected endpoints.",
      security: [{ apiToken: [] }],
      parameters: [
        {
          name: "X-API-Token",
          in: "header",
          description: "The static, pre-shared API token for your service.",
          required: true,
          schema: {
            type: "string",
          },
        },
      ],
      responses: {
        "200": {
          description: "Successfully generated and returned a JWT.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  data: {
                    type: "object",
                    properties: {
                      token: {
                        type: "string",
                        description:
                          "The JWT to be used for authenticating subsequent requests.",
                        example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "401": {
          description:
            "Unauthorized. The provided `X-API-Token` was missing or invalid.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
      },
    },
  },
  "/auth/me": {
    get: {
      tags: ["Auth"],
      summary: "Get current user information",
      description:
        "Returns information about the service or user associated with the provided JWT. This is useful for verifying that a token is valid and checking the identity of the authenticated party.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": {
          description: "Successfully retrieved identity information.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  data: {
                    type: "object",
                    properties: {
                      user: {
                        type: "object",
                        properties: {
                          id: { type: "string", example: "system" },
                          email: {
                            type: "string",
                            example: "system@scalius.com",
                          },
                          name: { type: "string", example: "System Service" },
                          role: { type: "string", example: "system" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "401": {
          description:
            "Unauthorized. The provided JWT was missing, invalid, or expired.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
      },
    },
  },
  "/auth/revoke": {
    post: {
      tags: ["Auth"],
      summary: "Revoke the current JWT",
      description:
        "Invalidates the currently used JWT by adding it to a server-side blacklist. The token will no longer be accepted for authentication, even if it has not yet expired. This is useful for logout functionality.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": {
          description: "Successfully revoked the token.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  message: {
                    type: "string",
                    example: "Token revoked successfully",
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/auth/token-stats": {
    get: {
      tags: ["Auth"],
      summary: "Get token statistics (Admin Only)",
      description:
        "Returns internal statistics about the JWT system, such as the number of currently blacklisted tokens. This endpoint is restricted to users with the 'admin' or 'system' role.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": {
          description: "Token system statistics.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  data: {
                    type: "object",
                    properties: {
                      blacklistedTokensCount: {
                        type: "integer",
                        example: 0,
                      },
                      jwtSecret: {
                        type: "string",
                        description:
                          "A partially redacted view of the JWT secret.",
                        example: "you...ion",
                      },
                      isUsingDefaultSecret: {
                        type: "boolean",
                        description:
                          "Indicates if the insecure default secret is being used.",
                        example: false,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/schemas/Error" },
        "403": {
          description:
            "Forbidden. The authenticated user does not have sufficient permissions.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
      },
    },
  },
};
