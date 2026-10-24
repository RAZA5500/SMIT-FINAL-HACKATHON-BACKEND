import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { isObjectIdString } from '../../common/pipes/parse-object-id.pipe.js';
import { AuditService } from '../audit/audit.service.js';
import { LeaveRequest, type LeaveRequestDocument } from '../leave/schemas/leave-request.schema.js';
import { CreateLeaveTypeDto, UpdateLeaveTypeDto } from './dto/org.dto.js';
import { DEFAULT_LEAVE_TYPES, LeaveType, type LeaveTypeDocument } from './schemas/leave-type.schema.js';

const CASE_INSENSITIVE = { locale: 'en', strength: 2 };

@Injectable()
export class LeaveTypesService {
  constructor(
    @InjectModel(LeaveType.name) private readonly leaveTypeModel: Model<LeaveTypeDocument>,
    @InjectModel(LeaveRequest.name) private readonly leaveRequestModel: Model<LeaveRequestDocument>,
    private readonly audit: AuditService,
  ) {}

  async create(actor: AuthUser, dto: CreateLeaveTypeDto) {
    const leaveType = await this.leaveTypeModel.create({
      name: dto.name,
      annualQuota: dto.annualQuota ?? null,
      isPaid: dto.isPaid ?? true,
      description: dto.description ?? '',
      isActive: dto.isActive ?? true,
    });
    await this.audit.record({ actor, action: 'create', entity: 'LeaveType', entityId: leaveType._id, after: leaveType });
    return leaveType.toJSON();
  }

  /** Creates the policy defaults (Annual 14, Sick 8, Casual 10, Unpaid unlimited) if missing. */
  async ensureDefaults(): Promise<void> {
    for (const { name, ...defaults } of DEFAULT_LEAVE_TYPES) {
      await this.leaveTypeModel
        .updateOne({ name }, { $setOnInsert: { ...defaults, isActive: true } }, { upsert: true })
        .collation(CASE_INSENSITIVE)
        .exec();
    }
  }

  async findAll(includeInactive = false) {
    const types = await this.leaveTypeModel
      .find(includeInactive ? {} : { isActive: true })
      .sort({ name: 1 })
      .exec();
    return types.map((t) => t.toJSON());
  }

  async findActiveDocuments(): Promise<LeaveTypeDocument[]> {
    return this.leaveTypeModel.find({ isActive: true }).sort({ name: 1 }).exec();
  }

  async findOne(id: string): Promise<LeaveTypeDocument> {
    const leaveType = await this.leaveTypeModel.findById(id).exec();
    if (!leaveType) throw new NotFoundException('Leave type not found');
    return leaveType;
  }

  /** Active leave type by id or name (case-insensitive); 422 if unknown or inactive. */
  async resolveActive(ref: string): Promise<LeaveTypeDocument> {
    const value = ref.trim();
    let leaveType: LeaveTypeDocument | null = null;
    if (isObjectIdString(value)) leaveType = await this.leaveTypeModel.findById(value).exec();
    if (!leaveType) {
      leaveType = await this.leaveTypeModel.findOne({ name: value }).collation(CASE_INSENSITIVE).exec();
    }
    if (!leaveType) throw new UnprocessableEntityException(`Unknown leave type "${ref}"`);
    if (!leaveType.isActive) throw new UnprocessableEntityException(`Leave type "${leaveType.name}" is not active`);
    return leaveType;
  }

  async update(actor: AuthUser, id: string, dto: UpdateLeaveTypeDto) {
    const leaveType = await this.findOne(id);
    const before = leaveType.toObject();
    if (dto.name !== undefined) leaveType.name = dto.name;
    if (dto.annualQuota !== undefined) leaveType.annualQuota = dto.annualQuota;
    if (dto.isPaid !== undefined) leaveType.isPaid = dto.isPaid;
    if (dto.description !== undefined) leaveType.description = dto.description;
    if (dto.isActive !== undefined) leaveType.isActive = dto.isActive;
    await leaveType.save();
    await this.audit.record({ actor, action: 'update', entity: 'LeaveType', entityId: leaveType._id, before, after: leaveType });
    return leaveType.toJSON();
  }

  async remove(actor: AuthUser, id: string): Promise<{ deleted: true }> {
    const leaveType = await this.findOne(id);
    const used = await this.leaveRequestModel.countDocuments({ leaveTypeId: leaveType._id }).exec();
    if (used > 0) {
      throw new ConflictException(
        `Leave type is used by ${used} leave request(s). Set isActive=false instead of deleting it.`,
      );
    }
    await leaveType.deleteOne();
    await this.audit.record({ actor, action: 'delete', entity: 'LeaveType', entityId: leaveType._id, before: leaveType });
    return { deleted: true };
  }
}
