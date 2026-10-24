import type { Schema } from 'mongoose';

/**
 * Consistent JSON shape for every collection: keeps `_id`, adds string `id`,
 * drops `__v`, and strips sensitive fields (e.g. password hashes) from all output —
 * including the before/after snapshots written to the audit log.
 */
export function applyBaseSchemaOptions<T extends Schema>(schema: T, hiddenFields: string[] = []): T {
  const transform = (_doc: unknown, ret: Record<string, unknown>) => {
    if (ret._id != null) ret.id = String(ret._id);
    delete ret.__v;
    for (const field of hiddenFields) delete ret[field];
    return ret;
  };
  schema.set('toJSON', { virtuals: true, versionKey: false, transform });
  schema.set('toObject', { virtuals: true, versionKey: false, transform });
  return schema;
}
