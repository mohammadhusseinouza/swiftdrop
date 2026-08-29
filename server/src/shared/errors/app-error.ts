export type AppErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "CONFLICT"
  | "INVALID_CREDENTIALS"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

interface AppErrorParams {
  statusCode: number;
  code: AppErrorCode;
  message: string;
  details?: unknown;
  isOperational?: boolean;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: AppErrorCode;
  readonly details?: unknown;
  readonly isOperational: boolean;

  constructor({ statusCode, code, message, details, isOperational = true }: AppErrorParams) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = isOperational;

    Object.setPrototypeOf(this, AppError.prototype);
  }
}
