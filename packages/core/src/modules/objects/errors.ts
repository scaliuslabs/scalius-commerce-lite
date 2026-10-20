import { AppError } from "@scalius/core/errors";

export class ObjectError extends AppError {
  readonly objectCode: string;
  constructor(code: string, message: string, details?: unknown) {
    super(code === "object_conflict" || code === "object_unique_violation" ? 409 : code === "object_not_found" ? 404 : code === "object_forbidden" ? 403 : 400, code, message, details);
    this.name = "ObjectError";
    this.objectCode = code;
  }
}
