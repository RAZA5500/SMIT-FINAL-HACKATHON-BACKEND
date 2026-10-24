import { registerDecorator, type ValidationOptions } from 'class-validator';
import { isValidIsoDate, isValidMonth, isValidTimeZone } from '../utils/date.util.js';

function simpleValidator(name: string, test: (value: unknown) => boolean, defaultMessage: (property: string) => string) {
  return (options?: ValidationOptions) =>
    (object: object, propertyName: string): void => {
      registerDecorator({
        name,
        target: object.constructor,
        propertyName,
        options: { message: defaultMessage(propertyName), ...options },
        validator: { validate: (value: unknown) => test(value) },
      });
    };
}

/** A real calendar date in `YYYY-MM-DD` format (rejects 2026-02-30). */
export const IsIsoDateOnly = simpleValidator(
  'isIsoDateOnly',
  isValidIsoDate,
  (property) => `${property} must be a valid date in YYYY-MM-DD format`,
);

/** A month in `YYYY-MM` format. */
export const IsMonthString = simpleValidator(
  'isMonthString',
  isValidMonth,
  (property) => `${property} must be a month in YYYY-MM format`,
);

/** An IANA timezone such as `Asia/Karachi`. */
export const IsTimeZone = simpleValidator(
  'isTimeZone',
  isValidTimeZone,
  (property) => `${property} must be a valid IANA timezone (e.g. Asia/Karachi)`,
);
