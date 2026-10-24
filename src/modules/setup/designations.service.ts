import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { isObjectIdString } from '../../common/pipes/parse-object-id.pipe.js';
import { AuditService } from '../audit/audit.service.js';
import { Employee, type EmployeeDocument } from '../employees/schemas/employee.schema.js';
import { CreateDesignationDto, UpdateDesignationDto } from './dto/org.dto.js';
import { Designation, type DesignationDocument } from './schemas/designation.schema.js';

const CASE_INSENSITIVE = { locale: 'en', strength: 2 };

@Injectable()
export class DesignationsService {
  constructor(
    @InjectModel(Designation.name) private readonly designationModel: Model<DesignationDocument>,
    @InjectModel(Employee.name) private readonly employeeModel: Model<EmployeeDocument>,
    private readonly audit: AuditService,
  ) {}

  async create(actor: AuthUser, dto: CreateDesignationDto) {
    const designation = await this.designationModel.create({
      name: dto.name,
      description: dto.description ?? '',
      isActive: dto.isActive ?? true,
    });
    await this.audit.record({ actor, action: 'create', entity: 'Designation', entityId: designation._id, after: designation });
    return designation.toJSON();
  }

  async findAll(includeInactive = false) {
    const designations = await this.designationModel
      .find(includeInactive ? {} : { isActive: true })
      .sort({ name: 1 })
      .exec();
    const counts = await this.employeeModel
      .aggregate<{ _id: unknown; count: number }>([
        { $match: { status: { $ne: 'exited' } } },
        { $group: { _id: '$designationId', count: { $sum: 1 } } },
      ])
      .exec();
    const byId = new Map(counts.map((c) => [String(c._id), c.count]));
    return designations.map((d) => ({ ...d.toJSON(), employeeCount: byId.get(String(d._id)) ?? 0 }));
  }

  async findOne(id: string): Promise<DesignationDocument> {
    const designation = await this.designationModel.findById(id).exec();
    if (!designation) throw new NotFoundException('Designation not found');
    return designation;
  }

  async update(actor: AuthUser, id: string, dto: UpdateDesignationDto) {
    const designation = await this.findOne(id);
    const before = designation.toObject();
    if (dto.name !== undefined) designation.name = dto.name;
    if (dto.description !== undefined) designation.description = dto.description;
    if (dto.isActive !== undefined) designation.isActive = dto.isActive;
    await designation.save();
    await this.audit.record({ actor, action: 'update', entity: 'Designation', entityId: designation._id, before, after: designation });
    return designation.toJSON();
  }

  async remove(actor: AuthUser, id: string): Promise<{ deleted: true }> {
    const designation = await this.findOne(id);
    const inUse = await this.employeeModel.countDocuments({ designationId: designation._id }).exec();
    if (inUse > 0) {
      throw new ConflictException(
        `Designation is assigned to ${inUse} employee(s). Reassign them or set isActive=false instead.`,
      );
    }
    await designation.deleteOne();
    await this.audit.record({ actor, action: 'delete', entity: 'Designation', entityId: designation._id, before: designation });
    return { deleted: true };
  }

  /** Finds a designation by id or name (case-insensitive). */
  async resolve(ref: string): Promise<DesignationDocument | null> {
    const value = ref.trim();
    if (!value) return null;
    if (isObjectIdString(value)) {
      const byId = await this.designationModel.findById(value).exec();
      if (byId) return byId;
    }
    return this.designationModel.findOne({ name: value }).collation(CASE_INSENSITIVE).exec();
  }

  async findAllDocuments(): Promise<DesignationDocument[]> {
    return this.designationModel.find().exec();
  }

  async nameMap(): Promise<Map<string, string>> {
    const designations = await this.designationModel.find({}, { name: 1 }).lean().exec();
    return new Map(designations.map((d) => [String(d._id), d.name]));
  }
}
