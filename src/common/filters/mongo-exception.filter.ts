import { Catch, HttpStatus, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import mongoose from 'mongoose';

/**
 * Maps database errors to clean HTTP responses:
 * - duplicate key (E11000) → 409 Conflict
 * - invalid ObjectId / cast → 400
 * - schema validation → 400
 */
@Catch(mongoose.mongo.MongoServerError, mongoose.Error.CastError, mongoose.Error.ValidationError)
export class MongoExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(MongoExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof mongoose.Error.CastError) {
      response.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        message: `Invalid value for "${exception.path}"`,
      });
      return;
    }

    if (exception instanceof mongoose.Error.ValidationError) {
      response.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        message: Object.values(exception.errors).map((e) => e.message),
      });
      return;
    }

    const mongoError = exception as { code?: number; keyValue?: Record<string, unknown>; message?: string };
    if (mongoError.code === 11000) {
      const fields = Object.keys(mongoError.keyValue ?? {});
      response.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        message: fields.length
          ? `A record with the same ${fields.join(', ')} already exists`
          : 'Duplicate record',
      });
      return;
    }

    this.logger.error(mongoError.message ?? 'Database error', (exception as Error)?.stack);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal Server Error',
      message: 'A database error occurred',
    });
  }
}

export function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
}
