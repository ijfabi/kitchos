import { Body, Controller, Inject, Ip, Param, Post, UseGuards } from '@nestjs/common';
import {
  CreateOverrideRequestSchema,
  type CreateOverrideRequest,
  type OverrideResponse,
} from '@kitchos/contracts';
import { Principal, RequirePermission, StaffAuthGuard } from '../auth/auth.guard.ts';
import type { StaffPrincipal } from '../auth/auth.service.ts';
import { CredentialThrottle } from '../infra/rate-limit.ts';
import { UuidParam, ZodPipe } from '../infra/zod.ts';
import { DiscountsService } from './discounts.service.ts';

/** Terminal re-authentication by an approver for one specific action. */
@Controller('v1/restaurants/:restaurantId/overrides')
@UseGuards(StaffAuthGuard)
export class OverridesController {
  constructor(
    @Inject(DiscountsService) private readonly discounts: DiscountsService,
    @Inject(CredentialThrottle) private readonly throttle: CredentialThrottle,
  ) {}

  @Post()
  @RequirePermission('discount.apply')
  create(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Body(new ZodPipe(CreateOverrideRequestSchema)) body: CreateOverrideRequest,
    @Principal() p: StaffPrincipal,
    @Ip() ip: string,
  ): Promise<OverrideResponse> {
    // Shares the sign-in password-guessing budget (per account, IP-independent)
    // and adds one per requesting user, so a terminal cannot be used to
    // brute-force an approver's password.
    return this.throttle.check({ ip, email: body.email, requesterId: p.userId }, () =>
      this.discounts.createOverride({ orgId: p.orgId, restaurantId, requesterId: p.userId }, body),
    );
  }
}
