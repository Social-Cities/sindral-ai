/** Error carrying an HTTP status and a stable machine-readable code. Mapped to `ApiError` by the app error handler. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: unknown): HttpError => new HttpError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Unauthorized'): HttpError => new HttpError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Forbidden'): HttpError => new HttpError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Resource'): HttpError => new HttpError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (message: string, details?: unknown): HttpError => new HttpError(409, 'CONFLICT', message, details);
export const serviceUnavailable = (message: string): HttpError => new HttpError(503, 'SERVICE_UNAVAILABLE', message);
