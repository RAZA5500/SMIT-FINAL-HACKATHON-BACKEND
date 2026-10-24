import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import bcrypt from 'bcrypt';
import { Model, Types } from 'mongoose';
import { Role } from '../../common/constants/roles.js';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { BCRYPT_ROUNDS, generateTempPassword } from '../../common/utils/password.util.js';
import { escapeRegex, paginate } from '../../common/utils/query.util.js';
import { AuditService } from '../audit/audit.service.js';
import { Employee, type EmployeeDocument } from '../employees/schemas/employee.schema.js';
import { ChangePasswordDto } from './dto/auth.dto.js';
import { CreateHrUserDto, ListUsersQueryDto, ResetPasswordDto, UpdateUserRoleDto } from './dto/users.dto.js';
import { User, type UserDocument } from './schemas/user.schema.js';

export interface CreateAccountParams {
  email: string;
  fullName: string;
  role: Role;
  employeeId?: string | Types.ObjectId | null;
  /** Omit to generate a random temporary password. */
  password?: string;
  mustChangePassword: boolean;
  createdBy?: string | null;
}

export interface UserProfile {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  employeeId: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Employee.name) private readonly employeeModel: Model<EmployeeDocument>,
    private readonly audit: AuditService,
  ) {}

  findById(id: string): Promise<UserDocument | null> {
    return this.userModel.findById(id).exec();
  }

  findByEmail(email: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ email: email.trim().toLowerCase() }).exec();
  }

  async emailExists(email: string): Promise<boolean> {
    return (await this.userModel.exists({ email: email.trim().toLowerCase() })) !== null;
  }

  async countAdmins(): Promise<number> {
    return this.userModel.countDocuments({ role: Role.Admin }).exec();
  }

  toAuthUser(user: UserDocument): AuthUser {
    return {
      userId: String(user._id),
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      employeeId: user.employeeId ? String(user.employeeId) : null,
      mustChangePassword: user.mustChangePassword,
    };
  }

  toProfile(user: UserDocument): UserProfile {
    return {
      id: String(user._id),
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      employeeId: user.employeeId ? String(user.employeeId) : null,
      isActive: user.isActive,
      mustChangePassword: user.mustChangePassword,
      lastLoginAt: user.lastLoginAt,
    };
  }

  /** Low-level account creation (hashes the password; returns the one-time temporary password). */
  async createAccount(params: CreateAccountParams): Promise<{ user: UserDocument; tempPassword: string | null }> {
    if (await this.emailExists(params.email)) {
      throw new ConflictException(`A login with email ${params.email} already exists`);
    }
    const tempPassword = params.password ? null : generateTempPassword();
    const passwordHash = await bcrypt.hash(params.password ?? tempPassword!, BCRYPT_ROUNDS);
    const user = await this.userModel.create({
      email: params.email,
      fullName: params.fullName,
      role: params.role,
      employeeId: params.employeeId ?? null,
      passwordHash,
      mustChangePassword: params.mustChangePassword,
      createdBy: params.createdBy ?? null,
    });
    return { user, tempPassword };
  }

  /** Hashes many temporary passwords in parallel (CSV import). */
  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, BCRYPT_ROUNDS);
  }

  /** Admin creates an HR login (optionally linked to an existing employee profile). */
  async createHrUser(actor: AuthUser, dto: CreateHrUserDto) {
    let employee: EmployeeDocument | null = null;
    if (dto.employeeId) {
      employee = await this.employeeModel.findById(dto.employeeId).exec();
      if (!employee) throw new NotFoundException('Employee not found');
      if (employee.status === 'exited') {
        throw new UnprocessableEntityException('Cannot link an HR login to an exited employee');
      }
      if (employee.userId) {
        throw new ConflictException(
          'This employee already has a login. Use PATCH /api/users/:id/role to promote it to HR instead.',
        );
      }
    }

    const { user, tempPassword } = await this.createAccount({
      email: dto.email,
      fullName: dto.fullName,
      role: Role.HR,
      employeeId: employee?._id ?? null,
      password: dto.password,
      mustChangePassword: true,
      createdBy: actor.userId,
    });
    if (employee) {
      await this.employeeModel.updateOne({ _id: employee._id }, { $set: { userId: user._id } }).exec();
    }

    await this.audit.record({ actor, action: 'create', entity: 'User', entityId: user._id, after: user });
    return {
      user: user.toJSON(),
      ...(tempPassword ? { temporaryPassword: tempPassword } : {}),
    };
  }

  async list(query: ListUsersQueryDto) {
    const filter: Record<string, unknown> = {};
    if (query.role) filter.role = query.role;
    if (query.isActive !== undefined) filter.isActive = query.isActive;
    if (query.q) {
      const regex = new RegExp(escapeRegex(query.q), 'i');
      filter.$or = [{ fullName: regex }, { email: regex }];
    }
    return paginate(this.userModel, filter, { page: query.page, limit: query.limit, sort: { createdAt: -1 } });
  }

  /** Admin activates/deactivates HR or Employee logins. Deactivation revokes all tokens. */
  async setActive(actor: AuthUser, id: string, isActive: boolean) {
    const user = await this.getManageableUser(actor, id);
    if (user.isActive === isActive) return user.toJSON();
    const before = user.toObject();
    user.isActive = isActive;
    if (!isActive) user.tokenVersion += 1;
    await user.save();
    await this.audit.record({
      actor,
      action: isActive ? 'activate' : 'deactivate',
      entity: 'User',
      entityId: user._id,
      before,
      after: user,
    });
    return user.toJSON();
  }

  /** Admin resets an HR/Employee password to a temporary one (must be changed at next login). */
  async resetPassword(actor: AuthUser, id: string, dto: ResetPasswordDto) {
    const user = await this.getManageableUser(actor, id);
    const temporaryPassword = dto.newPassword ?? generateTempPassword();
    user.passwordHash = await bcrypt.hash(temporaryPassword, BCRYPT_ROUNDS);
    user.mustChangePassword = true;
    user.passwordChangedAt = new Date();
    user.tokenVersion += 1;
    await user.save();
    await this.audit.record({
      actor,
      action: 'reset_password',
      entity: 'User',
      entityId: user._id,
      after: { mustChangePassword: true, passwordChangedAt: user.passwordChangedAt },
    });
    return { userId: String(user._id), email: user.email, temporaryPassword, mustChangePassword: true };
  }

  /** Admin promotes an employee login to HR (or demotes HR back to Employee). */
  async updateRole(actor: AuthUser, id: string, dto: UpdateUserRoleDto) {
    const user = await this.getManageableUser(actor, id);
    if (dto.role === Role.Employee && !user.employeeId) {
      throw new UnprocessableEntityException('An Employee login must be linked to an employee profile');
    }
    if (user.role === dto.role) return user.toJSON();
    const before = user.toObject();
    user.role = dto.role;
    user.tokenVersion += 1;
    await user.save();
    await this.audit.record({ actor, action: 'update', entity: 'User', entityId: user._id, before, after: user });
    return user.toJSON();
  }

  async changeOwnPassword(authUser: AuthUser, dto: ChangePasswordDto): Promise<UserDocument> {
    const user = await this.userModel.findById(authUser.userId).exec();
    if (!user) throw new NotFoundException('User not found');
    const matches = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!matches) throw new BadRequestException('Current password is incorrect');
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('New password must be different from the current password');
    }
    user.passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    user.mustChangePassword = false;
    user.passwordChangedAt = new Date();
    user.tokenVersion += 1;
    await user.save();
    await this.audit.record({
      actor: authUser,
      action: 'change_password',
      entity: 'User',
      entityId: user._id,
      after: { mustChangePassword: false, passwordChangedAt: user.passwordChangedAt },
    });
    return user;
  }

  /** Server-side logout: bumping the token version invalidates every token issued so far. */
  async revokeTokens(userId: string): Promise<void> {
    await this.userModel.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } }).exec();
  }

  async recordLogin(user: UserDocument): Promise<void> {
    await this.userModel.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } }).exec();
  }

  /** Called when an employee exits — their login is deactivated and tokens revoked. */
  async deactivateForEmployee(employeeId: string | Types.ObjectId): Promise<void> {
    await this.userModel
      .updateOne(
        { employeeId: new Types.ObjectId(String(employeeId)), isActive: true, role: { $ne: Role.Admin } },
        { $set: { isActive: false }, $inc: { tokenVersion: 1 } },
      )
      .exec();
  }

  /** Keeps the login's display name/email in sync with the employee profile. */
  async syncEmployeeIdentity(employeeId: string | Types.ObjectId, update: { fullName?: string; email?: string }) {
    const set: Record<string, string> = {};
    if (update.fullName) set.fullName = update.fullName;
    if (update.email) set.email = update.email;
    if (Object.keys(set).length === 0) return;
    await this.userModel.updateOne({ employeeId: new Types.ObjectId(String(employeeId)) }, { $set: set }).exec();
  }

  /** Admin may manage HR and Employee logins only — never other Admins or themselves. */
  private async getManageableUser(actor: AuthUser, id: string): Promise<UserDocument> {
    const user = await this.userModel.findById(id).exec();
    if (!user) throw new NotFoundException('User not found');
    if (String(user._id) === actor.userId) {
      throw new ForbiddenException('You cannot perform this action on your own account');
    }
    if (user.role === Role.Admin) {
      throw new ForbiddenException('Admin accounts cannot be managed through this endpoint');
    }
    return user;
  }
}
