import type { PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { ApiException } from './http-errors.ts';

/** Validates and parses untrusted input at the HTTP boundary. */
export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ApiException(400, 'VALIDATION_FAILED', 'Request validation failed', {
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }
}

export const UuidParam = new ZodPipe(z.uuid());
