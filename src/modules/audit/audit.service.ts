import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { paginate } from '../../common/utils/query.util.js';
import { AuditQueryDto } from './dto/audit-query.dto.js';
import { AuditLog, type AuditAction, type AuditLogDocument } from './schemas/audit-log.schema.js';

export interface AuditEntry {
  /** `null` = system action (startup bootstrap, scheduled job). */
  actor: AuthUser | null;
  action: AuditAction;
  entity: string;
  entityId?: unknown;
  before?: unknown;
  after?: unknown;
}

const SENSITIVE_KEYS = new Set(['passwordHash', 'password', 'tokenVersion', 'tempPassword']);

/** Converts documents/ObjectIds/Dates into plain JSON and strips secrets. */
export function toAuditSnapshot(value: unknown): unknown {
  if (value == null) return null;
  const plain =
    typeof (value as { toObject?: unknown }).toObject === 'function'
      ? (value as { toObject: () => unknown }).toObject()
      : value;
  const json = JSON.parse(JSON.stringify(plain)) as unknown;
  const scrub = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(scrub);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(node)) {
        if (!SENSITIVE_KEYS.has(key)) out[key] = scrub(val);
      }
      return out;
    }
    return node;
  };
  return scrub(json);
}

/**
 * Immutable audit trail: `record()` appends, `findAll()`/`findOne()` read. There is
 * deliberately no update or delete method, and the schema blocks those operations too.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@InjectModel(AuditLog.name) private readonly auditModel: Model<AuditLogDocument>) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.auditModel.create({
        actorId: entry.actor?.userId ?? null,
        actorRole: entry.actor?.role ?? 'System',
        actorEmail: entry.actor?.email ?? null,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId != null ? String(entry.entityId) : null,
        before: toAuditSnapshot(entry.before),
        after: toAuditSnapshot(entry.after),
      });
    } catch (error) {
      // The business change is already committed; never fail the request because of the log write.
      this.logger.error(
        `Failed to write audit log (${entry.action} ${entry.entity} ${String(entry.entityId)})`,
        (error as Error).stack,
      );
    }
  }

  async findAll(query: AuditQueryDto) {
    const filter: Record<string, unknown> = {};
    if (query.entity) filter.entity = query.entity;
    if (query.action) filter.action = query.action;
    if (query.actorId) filter.actorId = query.actorId;
    if (query.entityId) filter.entityId = query.entityId;
    if (query.from || query.to) {
      const createdAt: Record<string, Date> = {};
      if (query.from) createdAt.$gte = new Date(`${query.from}T00:00:00.000Z`);
      if (query.to) createdAt.$lte = new Date(`${query.to}T23:59:59.999Z`);
      filter.createdAt = createdAt;
    }
    return paginate(this.auditModel, filter, {
      page: query.page,
      limit: query.limit,
      sort: { createdAt: -1 },
    });
  }

  async findOne(id: string) {
    const log = await this.auditModel.findById(id).exec();
    if (!log) throw new NotFoundException('Audit log not found');
    return log.toJSON();
  }
}
