import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { withTenant, type Database } from '@kitchos/database';
import type { Request } from 'express';
import { forbidden, notFound } from '../infra/http-errors.ts';
import { DB } from '../infra/tokens.ts';
import { AuthService, type StaffPrincipal } from './auth.service.ts';
import { permissionsAt, type Permission, type RestaurantScope } from './permissions.ts';

/**
 * Declares the permission a route needs. Routes with a `:restaurantId` param
 * are checked against that restaurant's position in the hierarchy.
 */
export const RequirePermission = Reflector.createDecorator<Permission>();

export interface AuthedRequest extends Request {
  principal?: StaffPrincipal;
  restaurant?: RestaurantScope & { name: string; slug: string };
  permissions?: Set<Permission>;
}

@Injectable()
export class StaffAuthGuard implements CanActivate {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(DB) private readonly db: Database,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const principal = await this.auth.authenticate(req.headers.authorization);
    req.principal = principal;

    const required = this.reflector.get(RequirePermission, context.getHandler());
    const restaurantId = req.params.restaurantId;
    if (typeof restaurantId === 'string') {
      // RLS confines the lookup to the caller's tenant: another tenant's
      // restaurant is indistinguishable from a non-existent one (404, not 403).
      const restaurant = /^[0-9a-f-]{36}$/i.test(restaurantId)
        ? await withTenant(this.db, { orgId: principal.orgId }, (tx) =>
            this.auth.loadRestaurantScope(tx, restaurantId),
          )
        : undefined;
      if (!restaurant) throw notFound('Restaurant');
      const permissions = permissionsAt(principal.assignments, restaurant);
      if (permissions.size === 0) throw notFound('Restaurant');
      if (required && !permissions.has(required)) throw forbidden();
      req.restaurant = restaurant;
      req.permissions = permissions;
    } else if (required) {
      throw new Error(`Route requiring ${required} must be restaurant-scoped`);
    }
    return true;
  }
}

export const Principal = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): StaffPrincipal => {
    const p = ctx.switchToHttp().getRequest<AuthedRequest>().principal;
    if (!p) throw new Error('Principal requested on a route without StaffAuthGuard');
    return p;
  },
);

export const CurrentRestaurant = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const r = ctx.switchToHttp().getRequest<AuthedRequest>().restaurant;
  if (!r) throw new Error('CurrentRestaurant requested on a route without :restaurantId');
  return r;
});

export const CurrentPermissions = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Set<Permission> =>
    ctx.switchToHttp().getRequest<AuthedRequest>().permissions ?? new Set(),
);
