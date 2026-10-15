import { AppError } from "@scalius/core/errors";

export class ObjectError extends AppError {
  readonly objectCode: string;
  constructor(code: string, message: string, details?: unknown) {
    super(code === "object.conflict" || code === "object.unique_violation" ? 409 : code === "object.not_found" ? 404 : code === "object.forbidden" ? 403 : 400, code, message, details);
    this.name = "ObjectError";
    this.objectCode = code;
  }
}
