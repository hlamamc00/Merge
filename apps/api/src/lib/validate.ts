import type { Request } from 'express';
import { z } from 'zod';

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

export const zPostcode = z.string().trim().min(2).max(10).transform((s) => s.toUpperCase());
