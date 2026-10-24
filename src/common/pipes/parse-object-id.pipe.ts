import { BadRequestException, Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';

const OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;

export function isObjectIdString(value: unknown): value is string {
  return typeof value === 'string' && OBJECT_ID_REGEX.test(value);
}

/** Validates `:id` route params are 24-char hex ObjectIds (→ 400 instead of a cast error). */
@Injectable()
export class ParseObjectIdPipe implements PipeTransform<string, string> {
  transform(value: string, metadata: ArgumentMetadata): string {
    if (!isObjectIdString(value)) {
      throw new BadRequestException(`Invalid ${metadata.data ?? 'id'}: expected a 24-character ObjectId`);
    }
    return value;
  }
}
