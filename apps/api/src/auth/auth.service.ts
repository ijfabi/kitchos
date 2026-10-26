import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { hash as hashPassword, verify as verifyPassword } from '@node-rs/argon2';
import { withTenant, type Database, type Tx } from '@kitchos/database';
import type { MeResponse } from '@kitchos/contracts';
import { jwtVerify, SignJWT } from 'jose';
import { sql } from 'kysely';
import { APP_CONFIG, type AppConfig } from '../config.ts';
import { ApiException, unauthorized } from '../infra/http-errors.ts';
import { DB } from '../infra/tokens.ts';
import { permissionsAt, type RestaurantScope, type RoleAssignment } from './permissions.ts';

export interface StaffPrincipal {
  kind: 'staff';
  userId: string;
  orgId: string;
  email: string;
  displayName: string;
  assignments: RoleAssignment[];
}

const TOKEN_TTL_SECONDS = 8 * 60 * 60;
const ISSUER = 'kitchos-api';
const AUDIENCE = 'kitchos-staff';

@Injectable()
export class AuthService {
  private readonly key: Uint8Array;
  // Verified when the email is unknown so response timing does not reveal which accounts exist.
  private readonly dummyHash: Promise<string> = hashPassword(randomUUID());

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.key = new TextEncoder().encode(config.AUTH_JWT_SECRET);
  }

  async login(
    email: string,
    password: string,
  ): Promise<{ accessToken: string; expiresAt: string; principal: StaffPrincipal }> {
    const row = (
      await sql<{ user_id: string; org_id: string; password_hash: string; status: string }>`
        select * from app.lookup_login(${email})`.execute(this.db)
    ).rows[0];
    const ok = await verifyPassword(row?.password_hash ?? (await this.dummyHash), password).catch(
      () => false,
    );
    if (!row || !ok || row.status !== 'active') {
      throw new ApiException(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }
    const principal = await this.loadPrincipal(row.org_id, row.user_id);
    if (!principal)
      throw new ApiException(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');

    const expires = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
    const accessToken = await new SignJWT({ org: row.org_id, typ: 'staff' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(row.user_id)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(expires)
      .sign(this.key);
    return { accessToken, expiresAt: new Date(expires * 1000).toISOString(), principal };
  }

  /** Verifies a bearer token, then reloads the user and roles from the database (never trusts token claims for roles). */
  async authenticate(authorization: string | undefined): Promise<StaffPrincipal> {
    const match = /^Bearer (.+)$/.exec(authorization ?? '');
    if (!match) throw unauthorized();
    let claims: { sub?: string; org?: unknown; typ?: unknown };
    try {
      ({ payload: claims } = await jwtVerify(match[1]!, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      }));
    } catch {
      throw unauthorized('Invalid or expired token');
    }
    if (
      typeof claims.sub !== 'string' ||
      typeof claims.org !== 'string' ||
      claims.typ !== 'staff'
    ) {
      throw unauthorized('Invalid token');
    }
    const principal = await this.loadPrincipal(claims.org, claims.sub);
    if (!principal) throw unauthorized('Account is disabled');
    return principal;
  }

  private async loadPrincipal(orgId: string, userId: string): Promise<StaffPrincipal | null> {
    return withTenant(this.db, { orgId }, async (tx) => {
      const user = await tx
        .selectFrom('users')
        .select(['id', 'org_id', 'email', 'display_name', 'status'])
        .where('id', '=', userId)
        .executeTakeFirst();
      if (!user || user.status !== 'active') return null;
      const assignments = await tx
        .selectFrom('role_assignments')
        .select(['role', 'scope_type', 'scope_id'])
        .where('user_id', '=', userId)
        .execute();
      return {
        kind: 'staff' as const,
        userId: user.id,
        orgId: user.org_id,
        email: user.email,
        displayName: user.display_name,
        assignments: assignments.map((a) => ({
          role: a.role,
          scopeType: a.scope_type as RoleAssignment['scopeType'],
          scopeId: a.scope_id,
        })),
      };
    });
  }

  async loadRestaurantScope(
    tx: Tx,
    restaurantId: string,
  ): Promise<(RestaurantScope & { name: string; slug: string }) | undefined> {
    const r = await tx
      .selectFrom('restaurants')
      .select(['id', 'org_id', 'brand_id', 'region_id', 'name', 'slug'])
      .where('id', '=', restaurantId)
      .executeTakeFirst();
    return (
      r && {
        id: r.id,
        orgId: r.org_id,
        brandId: r.brand_id,
        regionId: r.region_id,
        name: r.name,
        slug: r.slug,
      }
    );
  }

  async describe(principal: StaffPrincipal): Promise<MeResponse> {
    const restaurants = await withTenant(this.db, { orgId: principal.orgId }, (tx) =>
      tx
        .selectFrom('restaurants')
        .select(['id', 'org_id', 'brand_id', 'region_id', 'name', 'slug'])
        .orderBy('name')
        .execute(),
    );
    return {
      user: {
        id: principal.userId,
        email: principal.email,
        displayName: principal.displayName,
        orgId: principal.orgId,
      },
      roles: principal.assignments,
      restaurants: restaurants
        .map((r) => ({
          id: r.id,
          slug: r.slug,
          name: r.name,
          permissions: [
            ...permissionsAt(principal.assignments, {
              id: r.id,
              orgId: r.org_id,
              brandId: r.brand_id,
              regionId: r.region_id,
            }),
          ].sort(),
        }))
        .filter((r) => r.permissions.length > 0),
    };
  }
}
