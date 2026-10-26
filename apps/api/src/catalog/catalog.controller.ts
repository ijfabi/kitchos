import { Controller, Get, Inject, Param } from '@nestjs/common';
import { withTenant, type Database } from '@kitchos/database';
import type { MenuResponse, PublicRestaurant } from '@kitchos/contracts';
import { sql } from 'kysely';
import { z } from 'zod';
import { DB } from '../infra/tokens.ts';
import { ZodPipe } from '../infra/zod.ts';
import { MenuRepository, resolvePublicRestaurant } from './menu.repository.ts';

export const SlugParam = new ZodPipe(z.string().regex(/^[a-z0-9-]{2,64}$/));

@Controller('v1/public/restaurants')
export class CatalogController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(MenuRepository) private readonly menus: MenuRepository,
  ) {}

  @Get()
  async list(): Promise<PublicRestaurant[]> {
    const { rows } =
      await sql<PublicRestaurant>`select * from app.list_public_restaurants()`.execute(this.db);
    return rows;
  }

  @Get(':slug/menu')
  async menu(@Param('slug', SlugParam) slug: string): Promise<MenuResponse> {
    const { restaurantId, orgId } = await resolvePublicRestaurant(this.db, slug);
    const menu = await withTenant(this.db, { orgId }, (tx) =>
      this.menus.loadMenu(tx, restaurantId),
    );
    return {
      restaurant: {
        slug: menu.restaurant.slug,
        name: menu.restaurant.name,
        address: menu.restaurant.address,
        timezone: menu.restaurant.timezone,
        currency: menu.restaurant.currency,
        openingHours: menu.restaurant.openingHours,
      },
      menuVersionId: menu.catalog.menuVersionId,
      items: menu.items,
    };
  }
}
