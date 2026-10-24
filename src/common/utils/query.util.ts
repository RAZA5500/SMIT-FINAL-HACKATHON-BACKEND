import type { Model, PopulateOptions, SortOrder } from 'mongoose';

export interface PaginatedResult<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export interface PaginateOptions {
  page: number;
  limit: number;
  sort?: Record<string, SortOrder>;
  populate?: PopulateOptions | PopulateOptions[];
  projection?: Record<string, 0 | 1>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = Model<any>;

/** Offset pagination → `{ data, meta: { page, limit, total, totalPages } }` (documents serialized via toJSON). */
export async function paginate(
  model: AnyModel,
  filter: Record<string, unknown>,
  { page, limit, sort = { createdAt: -1 }, populate, projection }: PaginateOptions,
): Promise<PaginatedResult<Record<string, unknown>>> {
  const query = model
    .find(filter, projection)
    .sort(sort)
    .skip((page - 1) * limit)
    .limit(limit);
  if (populate) query.populate(populate);
  const [docs, total] = await Promise.all([query.exec(), model.countDocuments(filter).exec()]);
  return {
    data: docs.map((doc: { toJSON: () => Record<string, unknown> }) => doc.toJSON()),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Converts any ObjectId-like value to its hex string (or null). */
export function idOf(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && '_id' in (value as Record<string, unknown>)) {
    return idOf((value as { _id: unknown })._id);
  }
  return String(value);
}
