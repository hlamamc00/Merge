import type { Request } from 'express';
import { z } from 'zod';
import { HttpError } from './errors.js';

export function parseBody<T extends z.ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  return schema.parse(req.body ?? {});
}

export function parseQuery<T extends z.ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  return schema.parse(req.query ?? {});
}

/** ISO date string → Date, rejecting invalid dates. */
export const zDate = z
  .union([z.string(), z.date()])
  .transform((v) => (v instanceof Date ? v : new Date(v)))
  .refine((d) => !Number.isNaN(d.getTime()), { message: 'Invalid date' });

export const zOptionalDate = zDate.nullable().optional();

/** Query-string boolean: "false"/"0" are false (z.coerce.boolean would turn any non-empty string into true). */
export const zQueryBool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .optional()
  .transform((v) => v === true || v === 'true' || v === '1');

/** PATCH bodies that carry no recognised field would otherwise make the update builder throw. */
export function assertChanges(body: Record<string, unknown>): void {
  if (Object.keys(body).length === 0) throw new HttpError(400, 'No recognised fields to update');
}

export const zPostcode = z.string().trim().min(2).max(10).transform((s) => s.toUpperCase());
