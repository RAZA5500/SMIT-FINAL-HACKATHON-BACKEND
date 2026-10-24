import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp, setupSwagger } from './app.setup.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  setupSwagger(app);

  const port = Number(app.get(ConfigService).get<string>('PORT') ?? 3000);
  await app.listen(port);
  Logger.log(`HCM Lite API listening on http://localhost:${port}/api  (Swagger: /api/docs)`, 'Bootstrap');
}

await bootstrap();
