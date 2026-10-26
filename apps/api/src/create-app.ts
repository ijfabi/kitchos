import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createDb } from '@kitchos/database';
import type { NextFunction, Request, Response } from 'express';
import { pino, type Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { AppModule } from './app.module.ts';
import type { AppConfig } from './config.ts';
import { ErrorFilter } from './infra/http-errors.ts';
import { metricsMiddleware } from './infra/metrics.ts';

export interface CreatedApp {
  app: INestApplication;
  logger: Logger;
  close: () => Promise<void>;
}

export async function createApp(config: AppConfig): Promise<CreatedApp> {
  const logger = pino({
    level: config.LOG_LEVEL,
    base: { service: 'kitchos-api' },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.paymentToken'],
      censor: '[redacted]',
    },
  });
  const { db, pool } = createDb({
    connectionString: config.DATABASE_URL,
    max: 20,
    applicationName: 'kitchos-api',
  });

  const app = await NestFactory.create(AppModule.register({ config, db, pool, logger }), {
    logger: config.NODE_ENV === 'test' ? false : ['error', 'warn'],
    bufferLogs: false,
  });
  const http = app.getHttpAdapter().getInstance() as {
    disable: (k: string) => void;
    set: (k: string, v: unknown) => void;
  };
  http.disable('x-powered-by');
  // Behind an ALB / CloudFront in production; trust only the first hop.
  http.set('trust proxy', 1);

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id =
          typeof incoming === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(incoming)
            ? incoming
            : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/health/live' || req.url === '/metrics' },
    }),
  );
  app.use(metricsMiddleware);
  app.enableCors({
    origin: config.CORS_ORIGINS.split(',').map((s) => s.trim()),
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Idempotent-Replayed'],
    credentials: false,
  });
  app.useGlobalFilters(new ErrorFilter(logger));
  app.enableShutdownHooks();
  await app.init();

  return {
    app,
    logger,
    close: async () => {
      await app.close();
      await db.destroy();
    },
  };
}
