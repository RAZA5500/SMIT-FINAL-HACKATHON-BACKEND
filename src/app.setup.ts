import { RequestMethod, ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { MongoExceptionFilter } from './common/filters/mongo-exception.filter.js';

export const API_PREFIX = 'api';

/** Shared HTTP setup for the real server and the e2e tests. */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);
  (app as NestExpressApplication).set('trust proxy', 1);

  // Every route lives under /api, except the root check at GET /.
  app.setGlobalPrefix(API_PREFIX, { exclude: [{ path: '/', method: RequestMethod.GET }] });
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  const origins = (config.get<string>('CORS_ORIGIN') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins.length ? origins : true,
    credentials: true,
    exposedHeaders: ['Content-Disposition'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new MongoExceptionFilter());
  app.enableShutdownHooks();
}

export function setupSwagger(app: INestApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('HCM Lite API')
      .setDescription(
        'AI-assisted Human Capital Management REST API for Admin, HR and Employee roles. ' +
          'Start with GET /api/setup/status → POST /api/setup/init → POST /api/auth/login, then click "Authorize".',
      )
      .setVersion('1.0.0')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup(`${API_PREFIX}/docs`, app, document, {
    jsonDocumentUrl: `${API_PREFIX}/docs-json`,
    swaggerOptions: { persistAuthorization: true },
  });
}
