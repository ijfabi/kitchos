import { Body, Controller, Get, HttpCode, Inject, Ip, Post, UseGuards } from '@nestjs/common';
import {
  LoginRequestSchema,
  type LoginRequest,
  type LoginResponse,
  type MeResponse,
} from '@kitchos/contracts';
import { CredentialThrottle } from '../infra/rate-limit.ts';
import { ZodPipe } from '../infra/zod.ts';
import { Principal, StaffAuthGuard } from './auth.guard.ts';
import { AuthService, type StaffPrincipal } from './auth.service.ts';

@Controller('v1')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CredentialThrottle) private readonly throttle: CredentialThrottle,
  ) {}

  @Post('auth/login')
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(LoginRequestSchema)) body: LoginRequest,
    @Ip() ip: string,
  ): Promise<LoginResponse> {
    const { accessToken, expiresAt, principal } = await this.throttle.check(
      { ip, email: body.email },
      () => this.auth.login(body.email, body.password),
    );
    return { accessToken, expiresAt, me: await this.auth.describe(principal) };
  }

  @Get('me')
  @UseGuards(StaffAuthGuard)
  me(@Principal() principal: StaffPrincipal): Promise<MeResponse> {
    return this.auth.describe(principal);
  }
}
