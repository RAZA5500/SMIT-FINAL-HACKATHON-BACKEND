import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AuthUser, JwtPayload } from '../../../common/interfaces/auth-user.interface.js';
import { UsersService } from '../users.service.js';

/**
 * Validates the Bearer token and re-loads the user on every request so that
 * deactivation, role changes and password resets take effect immediately.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly users: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    const user = payload?.sub ? await this.users.findById(payload.sub) : null;
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Your account is inactive or no longer exists');
    }
    if (user.tokenVersion !== payload.tv) {
      throw new UnauthorizedException('Your session has expired. Please log in again.');
    }
    return this.users.toAuthUser(user);
  }
}
