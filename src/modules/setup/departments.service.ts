import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { isObjectIdString } from '../../common/pipes/parse-object-id.pipe.js';
import { AuditService } from '../audit/audit.service.js';
import { Employee, type EmployeeDocument } from '../employees/schemas/employee.schema.js';
import { CreateDepartmentDto, UpdateDepartmentDto } from './dto/org.dto.js';
import { Department, type DepartmentDocument } from './schemas/department.schema.js';

const CASE_INSENSITIVE = { locale: 'en', strength: 2 };

@Injectable()
export class DepartmentsService {
  constructor(
    @InjectModel(Department.name) private readonly departmentModel: Model<DepartmentDocument>,
    @InjectModel(Employee.name) private readonly employeeModel: Model<EmployeeDocument>,
    private readonly audit: AuditService,
  ) {}

  async create(actor: AuthUser, dto: CreateDepartmentDto) {
    const department = await this.departmentModel.create({
      name: dto.name,
      code: dto.code ? dto.code.toUpperCase() : null,
      description: dto.description ?? '',
      isActive: dto.isActive ?? true,
    });
    await this.audit.record({ actor, action: 'create', entity: 'Department', entityId: department._id, after: department });
    return department.toJSON();
  }

  /** Departments with their current (non-exited) headcount. */
  async findAll(includeInactive = false) {
    const departments = await this.departmentModel
      .find(includeInactive ? {} : { isActive: true })
      .sort({ name: 1 })
      .exec();
    const counts = await this.employeeModel
      .aggregate<{ _id: unknown; count: number }>([
        { $match: { status: { $ne: 'exited' } } },
        { $group: { _id: '$departmentId', count: { $sum: 1 } } },
      ])
      .exec();
    const byId = new Map(counts.map((c) => [String(c._id), c.count]));
    return departments.map((d) => ({ ...d.toJSON(), employeeCount: byId.get(String(d._id)) ?? 0 }));
  }

  async findOne(id: string): Promise<DepartmentDocument> {
    const department = await this.departmentModel.findById(id).exec();
    if (!department) throw new NotFoundException('Department not found');
    return department;
  }

  async update(actor: AuthUser, id: string, dto: UpdateDepartmentDto) {
    const department = await this.findOne(id);
    const before = department.toObject();
    if (dto.name !== undefined) department.name = dto.name;
    if (dto.code !== undefined) department.code = dto.code ? dto.code.toUpperCase() : null;
    if (dto.description !== undefined) department.description = dto.description;
    if (dto.isActive !== undefined) department.isActive = dto.isActive;
    await department.save();
    await this.audit.record({ actor, action: 'update', entity: 'Department', entityId: department._id, before, after: department });
    return department.toJSON();
  }

  async remove(actor: AuthUser, id: string): Promise<{ deleted: true }> {
    const department = await this.findOne(id);
    const inUse = await this.employeeModel.countDocuments({ departmentId: department._id }).exec();
    if (inUse > 0) {
      throw new ConflictException(
        `Department is assigned to ${inUse} employee(s). Reassign them or set isActive=false instead.`,
      );
    }
    await department.deleteOne();
    await this.audit.record({ actor, action: 'delete', entity: 'Department', entityId: department._id, before: department });
    return { deleted: true };
  }

  /** Finds a department by id, name (case-insensitive) or code. */
  async resolve(ref: string): Promise<DepartmentDocument | null> {
    const value = ref.trim();
    if (!value) return null;
    if (isObjectIdString(value)) {
      const byId = await this.departmentModel.findById(value).exec();
      if (byId) return byId;
    }
    return this.departmentModel
      .findOne({ $or: [{ name: value }, { code: value.toUpperCase() }] })
      .collation(CASE_INSENSITIVE)
      .exec();
  }

  async findAllDocuments(): Promise<DepartmentDocument[]> {
    return this.departmentModel.find().exec();
  }

  async nameMap(): Promise<Map<string, string>> {
    const departments = await this.departmentModel.find({}, { name: 1 }).lean().exec();
    return new Map(departments.map((d) => [String(d._id), d.name]));
  }
}
