import type { FetchBaseQueryError } from '@reduxjs/toolkit/query';
import type { SerializedError } from '@reduxjs/toolkit';
import type { ApiErrorBody, ApiErrorResponse } from './apiTypes';

/**
 * Error interpretation utilities for the RTK Query layer.
 *
 * These deliberately preserve the backend's typed error `code` and any
 * validation `details` — they do NOT collapse everything into a single
 * "something went wrong" string, and they do NOT render UI (the ErrorState
 * component and toast layer are Phase 10.6).
 */

export type UnknownApiError = FetchBaseQueryError | SerializedError | undefined;

function isFetchBaseQueryError(
  error: UnknownApiError,
): error is FetchBaseQueryError {
  return typeof error === 'object' && error !== null && 'status' in error;
}

function isSerializedError(error: UnknownApiError): error is SerializedError {
  return (
    typeof error === 'object' &&
    error !== null &&
    !('status' in error) &&
    'message' in error
  );
}

function getBackendErrorBody(error: UnknownApiError): ApiErrorBody | undefined {
  if (!isFetchBaseQueryError(error)) return undefined;
  const data = 'data' in error ? error.data : undefined;
  if (
    typeof data === 'object' &&
    data !== null &&
    (data as ApiErrorResponse).success === false &&
    typeof (data as ApiErrorResponse).error === 'object'
  ) {
    return (data as ApiErrorResponse).error;
  }
  return undefined;
}

/** HTTP status number, or a transport marker string, or undefined. */
export function getApiErrorStatus(
  error: UnknownApiError,
): number | FetchBaseQueryError['status'] | undefined {
  return isFetchBaseQueryError(error) ? error.status : undefined;
}

/** Backend error `code` (e.g. "VALIDATION_ERROR", "FORBIDDEN"), if present. */
export function getApiErrorCode(error: UnknownApiError): string | undefined {
  return getBackendErrorBody(error)?.code;
}

/** Zod validation tree (`z.treeifyError`) from a 400 VALIDATION_ERROR, if present. */
export function getApiValidationDetails(error: UnknownApiError): unknown {
  const body = getBackendErrorBody(error);
  return body?.code === 'VALIDATION_ERROR' ? body.details : undefined;
}

/** A 401 (session/auth) — distinct from 403 (authenticated but forbidden). */
export function isAuthError(error: UnknownApiError): boolean {
  return getApiErrorStatus(error) === 401;
}

export function isForbiddenError(error: UnknownApiError): boolean {
  return getApiErrorStatus(error) === 403;
}

/** A transport-layer failure (offline, DNS, timeout, unparseable body). */
export function isTransportError(error: UnknownApiError): boolean {
  const status = getApiErrorStatus(error);
  return (
    status === 'FETCH_ERROR' ||
    status === 'TIMEOUT_ERROR' ||
    status === 'PARSING_ERROR'
  );
}

/**
 * Best-effort human-readable message, preferring the backend's own message.
 * Callers keep full typed context via the helpers above — this is only the
 * fallback text.
 */
export function getApiErrorMessage(error: UnknownApiError): string {
  const body = getBackendErrorBody(error);
  if (body?.message) return body.message;

  const status = getApiErrorStatus(error);
  if (status === 'FETCH_ERROR') return 'Unable to reach the server.';
  if (status === 'TIMEOUT_ERROR') return 'The request timed out.';
  if (status === 'PARSING_ERROR') return 'The server response could not be read.';
  if (typeof status === 'number') return `Request failed (HTTP ${status}).`;

  if (isSerializedError(error) && error.message) return error.message;
  return 'An unexpected error occurred.';
}
