import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { DomainError, type DomainErrorCode } from '@kitchos/domain';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';

/** An error the API deliberately returns to clients, with a stable code. */
export class ApiException extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ApiException(404, 'NOT_FOUND', `${what} not found`);
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new ApiException(403, 'FORBIDDEN', message);
export const unauthorized = (message = 'Authentication required') =>
  new ApiException(401, 'UNAUTHENTICATED', message);

const DOMAIN_STATUS: Record<DomainErrorCode, number> = {
  INVALID_STATE_TRANSITION: 409,
  MENU_ITEM_NOT_FOUND: 422,
  MENU_ITEM_UNAVAILABLE: 409,
  MODIFIER_NOT_FOUND: 422,
  MODIFIER_SELECTION_INVALID: 422,
  COMBO_COMPONENT_INVALID: 422,
  INVALID_QUANTITY: 422,
  INSUFFICIENT_STOCK: 409,
  AMOUNT_OUT_OF_RANGE: 422,
  CONCURRENT_MODIFICATION: 409,
  INSUFFICIENT_TENDER: 422,
  DISCOUNT_INVALID: 422,
  UNBALANCED_JOURNAL: 500,
};

@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();
    const requestId = typeof req.id === 'string' ? req.id : undefined;

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred';
    let details: Record<string, unknown> | undefined;

    if (exception instanceof ApiException) {
      ({ status, code, message, details } = exception);
    } else if (exception instanceof DomainError) {
      status = DOMAIN_STATUS[exception.code];
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = status === 404 ? 'NOT_FOUND' : `HTTP_${status}`;
      message = exception.message;
    } else if (isPgError(exception) && exception.code === '40001') {
      status = 409;
      code = 'CONCURRENT_MODIFICATION';
      message = 'The request conflicted with a concurrent change; retry it';
    }

    if (status >= 500) {
      this.logger.error({ err: exception, requestId }, 'unhandled error');
    }
    if (res.headersSent) return;
    res.status(status).json({ error: { code, message, details, requestId } });
  }
}

function isPgError(e: unknown): e is { code: string } {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string';
}
