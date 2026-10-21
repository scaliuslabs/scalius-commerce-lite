import { AppError } from "@scalius/core/errors";
import { APP_ERROR_CODES, type ObjectErrorCode } from "@scalius/shared/plugins/app-errors";

/** An Objects refusal: its code is a sealed app-facing code (`@scalius/shared/plugins/app-errors`), and so is its status. */
export class ObjectError extends AppError {
  readonly objectCode: ObjectErrorCode;
  constructor(code: ObjectErrorCode, message: string, details?: unknown) {
    super(APP_ERROR_CODES[code].status, code, message, details);
    this.name = "ObjectError";
    this.objectCode = code;
  }
}
