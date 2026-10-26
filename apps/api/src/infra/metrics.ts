import type { NextFunction, Request, Response } from 'express';
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

const httpDuration = new Histogram({
  name: 'kitchos_http_request_duration_seconds',
  help: 'HTTP request latency by route template and status',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

/** Records latency per route *template* (not raw URL) to keep label cardinality bounded. */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/metrics') return next();
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    const route = (req.route as { path?: string } | undefined)?.path;
    end({
      method: req.method,
      route: route ? `${req.baseUrl}${route}` : 'unmatched',
      status: String(res.statusCode),
    });
  });
  next();
}
