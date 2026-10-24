import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import bcrypt from 'bcrypt';
import { Model } from 'mongoose';
import type { AuthUser, JwtPayload } from '../../common/interfaces/auth-user.interface.js';
import { BCRYPT_ROUNDS } from '../../common/utils/password.util.js';
import { Employee, type EmployeeDocument } from '../employees/schemas/employee.schema.js';
import { ChangePasswordDto, LoginDto } from './dto/auth.dto.js';
import type { UserDocument } from './schemas/user.schema.js';
import { UsersService, type UserProfile } from './users.service.js';

export interface AuthResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: string;
  user: UserProfile;
}

@Injectable()
export class AuthService {
  /** Compared against when the email is unknown, so response time does not reveal valid emails. */
  private readonly dummyHash: Promise<string> = bcrypt.hash('hcm-lite-timing-guard', BCRYPT_ROUNDS);

  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectModel(Employee.name) private readonly employeeModel: Model<EmployeeDocument>,
  ) {}

  async login(dto: LoginDto): Promise<AuthResponse> {
    const user = await this.users.findByEmail(dto.email);
    const passwordOk = await bcrypt.compare(dto.password, user?.passwordHash ?? (await this.dummyHash));
    if (!user || !passwordOk) {
      throw new UnauthorizedException('Invalid email or password');
    }
    if (!user.isActive) {
      throw new ForbiddenException('Your account has been deactivated. Please contact your administrator.');
    }
    await this.users.recordLogin(user);
    return this.issueToken(user);
  }

  async changePassword(authUser: AuthUser, dto: ChangePasswordDto) {
    const user = await this.users.changeOwnPassword(authUser, dto);
    // The old token is revoked (tokenVersion bumped) — hand back a fresh one.
    return { message: 'Password changed successfully', ...this.issueToken(user) };
  }

  async logout(authUser: AuthUser): Promise<{ loggedOut: true }> {
    await this.users.revokeTokens(authUser.userId);
    return { loggedOut: true };
  }

  async me(authUser: AuthUser) {
    const user = await this.users.findById(authUser.userId);
    if (!user) throw new UnauthorizedException('User no longer exists');
    const employee = user.employeeId
      ? await this.employeeModel
          .findById(user.employeeId)
          .populate('departmentId', 'name')
          .populate('designationId', 'name')
          .exec()
      : null;
    return {
      ...this.users.toProfile(user),
      employee: employee
        ? {
            id: String(employee._id),
            code: employee.code,
            fullName: employee.fullName,
            status: employee.status,
            joinDate: employee.joinDate,
            department: employee.departmentId,
            designation: employee.designationId,
          }
        : null,
    };
  }

  issueToken(user: UserDocument): AuthResponse {
    const payload: JwtPayload = {
      sub: String(user._id),
      role: user.role,
      employeeId: user.employeeId ? String(user.employeeId) : null,
      tv: user.tokenVersion,
    };
    return {
      accessToken: this.jwt.sign(payload),
      tokenType: 'Bearer',
      expiresIn: this.config.get<string>('JWT_EXPIRES_IN') ?? '1d',
      user: this.users.toProfile(user),
    };
  }
}
