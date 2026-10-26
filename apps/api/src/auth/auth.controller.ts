import { Body, Controller, Get, HttpCode, Inject, Ip, Post, UseGuards } from '@nestjs/common';
import {
  LoginRequestSchema,
  type LoginRequest,
  type LoginResponse,
  type MeResponse,
} from '@kitchos/contracts';
import { FixedWindowLimiter } from '../infra/rate-limit.ts';
import { ZodPipe } from '../infra/zod.ts';
import { Principal, StaffAuthGuard } from './auth.guard.ts';
import { AuthService, type StaffPrincipal } from './auth.service.ts';

@Controller('v1')
export class AuthController {
  // 10 attempts per 15 minutes per (IP, email) and 50 per IP.
  private readonly perAccount = new FixedWindowLimiter(10, 15 * 60_000);
  private readonly perIp = new FixedWindowLimiter(50, 15 * 60_000);

  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('auth/login')
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(LoginRequestSchema)) body: LoginRequest,
    @Ip() ip: string,
  ): Promise<LoginResponse> {
    this.perIp.consume(ip);
    this.perAccount.consume(`${ip}|${body.email.toLowerCase()}`);
    const { accessToken, expiresAt, principal } = await this.auth.login(body.email, body.password);
    return { accessToken, expiresAt, me: await this.auth.describe(principal) };
  }

  @Get('me')
  @UseGuards(StaffAuthGuard)
  me(@Principal() principal: StaffPrincipal): Promise<MeResponse> {
    return this.auth.describe(principal);
  }
}
