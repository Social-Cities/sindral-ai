import { z } from 'zod';
import type { ZodType } from 'zod';
import { HttpError } from './errors.js';

/** Parse `value` with a zod schema; throws a 400 with the zod issues as details. */
export function validate<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Request validation failed', result.error.issues);
  }
  return result.data;
}

export const idParamsSchema = z.object({ id: z.string().uuid() });
export const providerParamsSchema = z.object({ provider: z.enum(['github', 'linear', 'jira']) });
