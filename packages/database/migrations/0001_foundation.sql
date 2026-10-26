-- KitchOS 0001: tenancy, identity, catalog (menus/recipes), inventory ledger,
-- orders, payments, kitchen tasks, outbox, idempotency, audit.
--
-- Conventions
--   * Every tenant-owned table has org_id and a row-level security policy.
--   * Money: bigint minor units (cents). Quantities: numeric(18,3) in the
--     inventory item's base unit.
--   * Append-only tables reject UPDATE/DELETE via trigger, and the runtime role
--     is additionally not granted those privileges.
--   * Published menu/recipe versions are immutable.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA app;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Current tenant, set per transaction by the API with set_config(..., true).
-- Returns NULL when unset, which makes every RLS policy deny.
CREATE FUNCTION app.current_org() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.org_id', true), '')::uuid
$$;

CREATE FUNCTION app.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KITCHOS_APPEND_ONLY: % on % is not permitted', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- Tenancy hierarchy: Organisation -> Brand -> Region -> Restaurant -> Station -> Device
-- ---------------------------------------------------------------------------

CREATE TABLE organisations (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,64}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE brands (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      uuid NOT NULL REFERENCES organisations(id),
  name        text NOT NULL,
  slug        text NOT NULL CHECK (slug ~ '^[a-z0-9-]{2,64}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug),
  UNIQUE (org_id, id)
);

CREATE TABLE regions (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      uuid NOT NULL REFERENCES organisations(id),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name),
  UNIQUE (org_id, id)
);

CREATE TABLE menus (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      uuid NOT NULL,
  brand_id    uuid NOT NULL,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, brand_id) REFERENCES brands(org_id, id)
);

CREATE TABLE restaurants (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id                 uuid NOT NULL,
  brand_id               uuid NOT NULL,
  region_id              uuid NOT NULL,
  menu_id                uuid NOT NULL,
  name                   text NOT NULL,
  slug                   text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,64}$'),
  ownership              text NOT NULL CHECK (ownership IN ('company', 'franchise')),
  timezone               text NOT NULL,
  currency               char(3) NOT NULL DEFAULT 'AUD',
  -- Local time at which one business day ends and the next begins.
  business_day_cutoff    time NOT NULL DEFAULT '04:00',
  tax_rate_bp            integer NOT NULL DEFAULT 1000 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  stock_shortage_policy  text NOT NULL DEFAULT 'block'
                           CHECK (stock_shortage_policy IN ('block', 'allow_negative')),
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  address                text,
  opening_hours          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, brand_id) REFERENCES brands(org_id, id),
  FOREIGN KEY (org_id, region_id) REFERENCES regions(org_id, id),
  FOREIGN KEY (org_id, menu_id) REFERENCES menus(org_id, id)
);

-- Business date of a timestamp for a restaurant (timezone + cutoff aware).
CREATE FUNCTION app.business_date(p_restaurant_id uuid, p_at timestamptz) RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT ((p_at AT TIME ZONE r.timezone) - r.business_day_cutoff)::date
  FROM restaurants r WHERE r.id = p_restaurant_id
$$;

CREATE TABLE stations (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id         uuid NOT NULL,
  restaurant_id  uuid NOT NULL,
  code           text NOT NULL CHECK (code ~ '^[a-z0-9-]{2,32}$'),
  name           text NOT NULL,
  -- Station types this station prepares, e.g. {grill,assembly}. Routing picks
  -- the first active station (by display_order) that handles a task's type.
  station_types  text[] NOT NULL CHECK (cardinality(station_types) > 0),
  display_order  integer NOT NULL DEFAULT 0,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, code),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, restaurant_id) REFERENCES restaurants(org_id, id)
);

CREATE TABLE devices (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id         uuid NOT NULL,
  restaurant_id  uuid NOT NULL,
  station_id     uuid,
  kind           text NOT NULL CHECK (kind IN ('pos', 'kiosk', 'kds', 'pickup_display', 'time_clock', 'signage')),
  name           text NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  last_seen_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, restaurant_id) REFERENCES restaurants(org_id, id),
  FOREIGN KEY (org_id, station_id) REFERENCES stations(org_id, id)
);

-- ---------------------------------------------------------------------------
-- Identity and authorisation
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id         uuid NOT NULL REFERENCES organisations(id),
  email          text NOT NULL,
  display_name   text NOT NULL,
  password_hash  text NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE role_assignments (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      uuid NOT NULL,
  user_id     uuid NOT NULL,
  role        text NOT NULL CHECK (role IN (
                'crew_member', 'crew_trainer', 'shift_supervisor', 'assistant_manager',
                'restaurant_manager', 'area_manager', 'regional_manager', 'franchise_owner',
                'inventory_controller', 'payroll_administrator', 'head_office_administrator',
                'auditor', 'platform_administrator')),
  scope_type  text NOT NULL CHECK (scope_type IN ('organisation', 'brand', 'region', 'restaurant')),
  scope_id    uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role, scope_type, scope_id),
  FOREIGN KEY (org_id, user_id) REFERENCES users(org_id, id)
);

-- ---------------------------------------------------------------------------
-- Inventory catalog and ledger
-- ---------------------------------------------------------------------------

CREATE TABLE inventory_items (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      uuid NOT NULL REFERENCES organisations(id),
  sku         text NOT NULL,
  name        text NOT NULL,
  base_unit   text NOT NULL CHECK (base_unit IN ('each', 'g', 'ml')),
  category    text NOT NULL CHECK (category IN ('ingredient', 'packaging')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, sku),
  UNIQUE (org_id, id)
);

CREATE TABLE stock_locations (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id         uuid NOT NULL,
  restaurant_id  uuid NOT NULL,
  code           text NOT NULL,
  name           text NOT NULL,
  is_default     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, code),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, restaurant_id) REFERENCES restaurants(org_id, id)
);
CREATE UNIQUE INDEX stock_locations_one_default ON stock_locations (restaurant_id) WHERE is_default;

-- Append-only physical inventory ledger. Every row is a fact that happened.
CREATE TABLE stock_movements (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id             uuid NOT NULL,
  restaurant_id      uuid NOT NULL,
  location_id        uuid NOT NULL,
  inventory_item_id  uuid NOT NULL,
  movement_type      text NOT NULL CHECK (movement_type IN (
                       'receipt', 'production_consumption', 'waste_raw', 'transfer_in',
                       'transfer_out', 'staff_meal', 'complimentary_meal', 'count_adjustment',
                       'return_to_stock', 'batch_production', 'correction')),
  quantity_delta     numeric(18,3) NOT NULL CHECK (quantity_delta <> 0),
  -- The operation that caused this movement. Together with the item and type
  -- this is unique, which makes replaying the same operation a no-op.
  source_type        text NOT NULL,
  source_id          uuid NOT NULL,
  source_key         text NOT NULL DEFAULT '',
  actor_user_id      uuid,
  actor_device_id    uuid,
  occurred_at        timestamptz NOT NULL,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  business_date      date NOT NULL,
  notes              text,
  CONSTRAINT stock_movements_source_unique
    UNIQUE (org_id, source_type, source_id, source_key, inventory_item_id, movement_type),
  CONSTRAINT stock_movements_sign CHECK (
    CASE movement_type
      WHEN 'receipt' THEN quantity_delta > 0
      WHEN 'transfer_in' THEN quantity_delta > 0
      WHEN 'return_to_stock' THEN quantity_delta > 0
      WHEN 'batch_production' THEN quantity_delta > 0
      WHEN 'production_consumption' THEN quantity_delta < 0
      WHEN 'waste_raw' THEN quantity_delta < 0
      WHEN 'transfer_out' THEN quantity_delta < 0
      WHEN 'staff_meal' THEN quantity_delta < 0
      WHEN 'complimentary_meal' THEN quantity_delta < 0
      ELSE true
    END),
  FOREIGN KEY (org_id, location_id) REFERENCES stock_locations(org_id, id),
  FOREIGN KEY (org_id, inventory_item_id) REFERENCES inventory_items(org_id, id),
  FOREIGN KEY (org_id, restaurant_id) REFERENCES restaurants(org_id, id)
);
CREATE INDEX stock_movements_item_time ON stock_movements (location_id, inventory_item_id, occurred_at);
CREATE INDEX stock_movements_source ON stock_movements (source_type, source_id);

-- Balance projection, maintained ONLY by the trigger on stock_movements (for
-- on_hand) and by reservation code (for reserved). Reconcilable at any time:
--   on_hand = sum(stock_movements.quantity_delta)
CREATE TABLE stock_balances (
  org_id             uuid NOT NULL,
  location_id        uuid NOT NULL,
  inventory_item_id  uuid NOT NULL,
  on_hand            numeric(18,3) NOT NULL DEFAULT 0,
  reserved           numeric(18,3) NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  version            bigint NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, inventory_item_id),
  FOREIGN KEY (org_id, location_id) REFERENCES stock_locations(org_id, id),
  FOREIGN KEY (org_id, inventory_item_id) REFERENCES inventory_items(org_id, id)
);

CREATE FUNCTION app.apply_stock_movement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO stock_balances AS b (org_id, location_id, inventory_item_id, on_hand, version)
  VALUES (NEW.org_id, NEW.location_id, NEW.inventory_item_id, NEW.quantity_delta, 1)
  ON CONFLICT (location_id, inventory_item_id) DO UPDATE
    SET on_hand = b.on_hand + EXCLUDED.on_hand,
        version = b.version + 1,
        updated_at = now();
  RETURN NULL;
END
$$;

CREATE TRIGGER stock_movements_apply AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION app.apply_stock_movement();
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER stock_movements_no_truncate BEFORE TRUNCATE ON stock_movements
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Catalog: products, versioned recipes, versioned menus
-- ---------------------------------------------------------------------------

CREATE TABLE products (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id       uuid NOT NULL,
  brand_id     uuid NOT NULL,
  sku          text NOT NULL,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  kind         text NOT NULL CHECK (kind IN ('item', 'combo')),
  taxable      boolean NOT NULL DEFAULT true,
  allergens    text[] NOT NULL DEFAULT '{}',
  energy_kj    integer CHECK (energy_kj >= 0),
  image_url    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_id, sku),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, brand_id) REFERENCES brands(org_id, id)
);

CREATE TABLE recipes (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      uuid NOT NULL,
  product_id  uuid NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, product_id) REFERENCES products(org_id, id)
);

CREATE TABLE recipe_versions (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id             uuid NOT NULL,
  recipe_id          uuid NOT NULL,
  version            integer NOT NULL CHECK (version > 0),
  station_type       text NOT NULL,
  consumption_point  text NOT NULL CHECK (consumption_point IN ('order_accepted', 'task_started', 'task_completed')),
  instructions       text NOT NULL DEFAULT '',
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  published_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recipe_id, version),
  UNIQUE (org_id, id),
  CHECK ((status = 'draft') = (published_at IS NULL)),
  FOREIGN KEY (org_id, recipe_id) REFERENCES recipes(org_id, id)
);

CREATE TABLE recipe_lines (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id             uuid NOT NULL,
  recipe_version_id  uuid NOT NULL,
  inventory_item_id  uuid NOT NULL,
  quantity           numeric(18,3) NOT NULL CHECK (quantity > 0),
  UNIQUE (recipe_version_id, inventory_item_id),
  FOREIGN KEY (org_id, recipe_version_id) REFERENCES recipe_versions(org_id, id),
  FOREIGN KEY (org_id, inventory_item_id) REFERENCES inventory_items(org_id, id)
);

CREATE TABLE menu_versions (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id        uuid NOT NULL,
  menu_id       uuid NOT NULL,
  version       integer NOT NULL CHECK (version > 0),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  published_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (menu_id, version),
  UNIQUE (org_id, id),
  CHECK ((status = 'draft') = (published_at IS NULL)),
  FOREIGN KEY (org_id, menu_id) REFERENCES menus(org_id, id)
);

CREATE TABLE menu_items (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id             uuid NOT NULL,
  menu_version_id    uuid NOT NULL,
  product_id         uuid NOT NULL,
  category           text NOT NULL,
  display_order      integer NOT NULL DEFAULT 0,
  price_cents        bigint NOT NULL CHECK (price_cents >= 0),
  -- Pinned recipe for simple items; NULL for combos (components pin their own).
  recipe_version_id  uuid,
  UNIQUE (menu_version_id, product_id),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, menu_version_id) REFERENCES menu_versions(org_id, id),
  FOREIGN KEY (org_id, product_id) REFERENCES products(org_id, id),
  FOREIGN KEY (org_id, recipe_version_id) REFERENCES recipe_versions(org_id, id)
);

CREATE TABLE combo_components (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id             uuid NOT NULL,
  menu_item_id       uuid NOT NULL,
  product_id         uuid NOT NULL,
  quantity           integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  recipe_version_id  uuid NOT NULL,
  display_order      integer NOT NULL DEFAULT 0,
  UNIQUE (menu_item_id, product_id),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, menu_item_id) REFERENCES menu_items(org_id, id),
  FOREIGN KEY (org_id, product_id) REFERENCES products(org_id, id),
  FOREIGN KEY (org_id, recipe_version_id) REFERENCES recipe_versions(org_id, id)
);

-- Modifier groups belong to a product within a menu version, so the same
-- burger modifiers apply whether it is sold alone or inside a meal.
CREATE TABLE modifier_groups (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id           uuid NOT NULL,
  menu_version_id  uuid NOT NULL,
  product_id       uuid NOT NULL,
  name             text NOT NULL,
  min_select       integer NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select       integer NOT NULL CHECK (max_select >= min_select AND max_select > 0),
  display_order    integer NOT NULL DEFAULT 0,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, menu_version_id) REFERENCES menu_versions(org_id, id),
  FOREIGN KEY (org_id, product_id) REFERENCES products(org_id, id)
);

CREATE TABLE modifier_options (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id             uuid NOT NULL,
  modifier_group_id  uuid NOT NULL,
  name               text NOT NULL,
  price_delta_cents  bigint NOT NULL DEFAULT 0,
  display_order      integer NOT NULL DEFAULT 0,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, modifier_group_id) REFERENCES modifier_groups(org_id, id)
);

CREATE TABLE modifier_option_ingredients (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id              uuid NOT NULL,
  modifier_option_id  uuid NOT NULL,
  inventory_item_id   uuid NOT NULL,
  quantity_delta      numeric(18,3) NOT NULL CHECK (quantity_delta <> 0),
  UNIQUE (modifier_option_id, inventory_item_id),
  FOREIGN KEY (org_id, modifier_option_id) REFERENCES modifier_options(org_id, id),
  FOREIGN KEY (org_id, inventory_item_id) REFERENCES inventory_items(org_id, id)
);

-- Operational availability ("86'd" items) — restaurant-scoped, not versioned config.
CREATE TABLE product_availability (
  org_id         uuid NOT NULL,
  restaurant_id  uuid NOT NULL,
  product_id     uuid NOT NULL,
  available      boolean NOT NULL,
  reason         text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, product_id),
  FOREIGN KEY (org_id, restaurant_id) REFERENCES restaurants(org_id, id),
  FOREIGN KEY (org_id, product_id) REFERENCES products(org_id, id)
);

-- Published versions are immutable (invariant 8: orders retain the versions they used).
CREATE FUNCTION app.guard_published_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'KITCHOS_IMMUTABLE: cannot delete a % %', OLD.status, TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  -- Only forward status changes (published -> retired) are allowed afterwards.
  IF OLD.status = 'published' AND NEW.status = 'retired'
     AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'KITCHOS_IMMUTABLE: % % is %', TG_TABLE_NAME, OLD.id, OLD.status
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER menu_versions_guard BEFORE UPDATE OR DELETE ON menu_versions
  FOR EACH ROW EXECUTE FUNCTION app.guard_published_version();
CREATE TRIGGER recipe_versions_guard BEFORE UPDATE OR DELETE ON recipe_versions
  FOR EACH ROW EXECUTE FUNCTION app.guard_published_version();

-- Children of a published version cannot change. Each child table resolves its
-- owning version through a SQL expression passed as a trigger argument.
CREATE FUNCTION app.guard_version_child() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_row record;
BEGIN
  v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  EXECUTE TG_ARGV[0] INTO v_status USING v_row;
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'KITCHOS_IMMUTABLE: % belongs to a % version', TG_TABLE_NAME, coalesce(v_status, 'unknown')
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Also block moving a row out of a published version.
    EXECUTE TG_ARGV[0] INTO v_status USING OLD;
    IF v_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'KITCHOS_IMMUTABLE: % belongs to a % version', TG_TABLE_NAME, v_status
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN v_row;
END
$$;

CREATE TRIGGER recipe_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON recipe_lines
  FOR EACH ROW EXECUTE FUNCTION app.guard_version_child(
    'SELECT status FROM recipe_versions WHERE id = ($1).recipe_version_id');
CREATE TRIGGER menu_items_guard BEFORE INSERT OR UPDATE OR DELETE ON menu_items
  FOR EACH ROW EXECUTE FUNCTION app.guard_version_child(
    'SELECT status FROM menu_versions WHERE id = ($1).menu_version_id');
CREATE TRIGGER combo_components_guard BEFORE INSERT OR UPDATE OR DELETE ON combo_components
  FOR EACH ROW EXECUTE FUNCTION app.guard_version_child(
    'SELECT v.status FROM menu_items i JOIN menu_versions v ON v.id = i.menu_version_id WHERE i.id = ($1).menu_item_id');
CREATE TRIGGER modifier_groups_guard BEFORE INSERT OR UPDATE OR DELETE ON modifier_groups
  FOR EACH ROW EXECUTE FUNCTION app.guard_version_child(
    'SELECT status FROM menu_versions WHERE id = ($1).menu_version_id');
CREATE TRIGGER modifier_options_guard BEFORE INSERT OR UPDATE OR DELETE ON modifier_options
  FOR EACH ROW EXECUTE FUNCTION app.guard_version_child(
    'SELECT v.status FROM modifier_groups g JOIN menu_versions v ON v.id = g.menu_version_id WHERE g.id = ($1).modifier_group_id');
CREATE TRIGGER modifier_option_ingredients_guard BEFORE INSERT OR UPDATE OR DELETE ON modifier_option_ingredients
  FOR EACH ROW EXECUTE FUNCTION app.guard_version_child(
    'SELECT v.status FROM modifier_options o JOIN modifier_groups g ON g.id = o.modifier_group_id JOIN menu_versions v ON v.id = g.menu_version_id WHERE o.id = ($1).modifier_option_id');

-- ---------------------------------------------------------------------------
-- Orders, lines, payments
-- ---------------------------------------------------------------------------

CREATE TABLE restaurant_order_counters (
  org_id         uuid NOT NULL,
  restaurant_id  uuid NOT NULL,
  business_date  date NOT NULL,
  last_number    integer NOT NULL,
  PRIMARY KEY (restaurant_id, business_date),
  FOREIGN KEY (org_id, restaurant_id) REFERENCES restaurants(org_id, id)
);

CREATE TABLE orders (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id              uuid NOT NULL,
  restaurant_id       uuid NOT NULL,
  order_number        integer NOT NULL,
  business_date       date NOT NULL,
  channel             text NOT NULL CHECK (channel IN ('web', 'pos', 'kiosk', 'drive_thru', 'delivery')),
  fulfilment_type     text NOT NULL CHECK (fulfilment_type IN ('dine_in', 'takeaway', 'pickup', 'drive_thru', 'delivery')),
  status              text NOT NULL CHECK (status IN ('pending_payment', 'accepted', 'in_preparation', 'ready', 'completed', 'cancelled')),
  menu_version_id     uuid NOT NULL,
  currency            char(3) NOT NULL,
  subtotal_cents      bigint NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents      bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  total_cents         bigint NOT NULL CHECK (total_cents >= 0),
  tax_cents           bigint NOT NULL CHECK (tax_cents >= 0 AND tax_cents <= total_cents),
  tax_rate_bp         integer NOT NULL,
  customer_name       text,
  -- Unguessable token letting a guest view only their own order.
  public_token        text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  created_by_user_id  uuid,
  created_by_device_id uuid,
  version             integer NOT NULL DEFAULT 1,
  placed_at           timestamptz NOT NULL DEFAULT now(),
  accepted_at         timestamptz,
  ready_at            timestamptz,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  cancel_reason       text,
  UNIQUE (restaurant_id, business_date, order_number),
  UNIQUE (org_id, id),
  CHECK (total_cents = subtotal_cents - discount_cents),
  FOREIGN KEY (org_id, restaurant_id) REFERENCES restaurants(org_id, id),
  FOREIGN KEY (org_id, menu_version_id) REFERENCES menu_versions(org_id, id)
);
CREATE INDEX orders_restaurant_status ON orders (restaurant_id, status, placed_at);

CREATE TABLE order_lines (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id             uuid NOT NULL,
  order_id           uuid NOT NULL,
  parent_line_id     uuid,
  line_no            integer NOT NULL,
  menu_item_id       uuid,
  combo_component_id uuid,
  product_id         uuid NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('item', 'combo', 'component')),
  name               text NOT NULL,
  quantity           integer NOT NULL CHECK (quantity > 0),
  unit_price_cents   bigint NOT NULL DEFAULT 0,
  line_total_cents   bigint NOT NULL DEFAULT 0,
  taxable            boolean NOT NULL,
  -- Production details, NULL for combo parents (their components produce).
  recipe_version_id  uuid,
  station_type       text,
  consumption_point  text CHECK (consumption_point IN ('order_accepted', 'task_started', 'task_completed')),
  UNIQUE (org_id, id),
  CHECK ((kind = 'combo') = (recipe_version_id IS NULL)),
  CHECK ((kind = 'component') = (parent_line_id IS NOT NULL)),
  FOREIGN KEY (org_id, order_id) REFERENCES orders(org_id, id),
  FOREIGN KEY (org_id, parent_line_id) REFERENCES order_lines(org_id, id),
  FOREIGN KEY (org_id, recipe_version_id) REFERENCES recipe_versions(org_id, id)
);
CREATE INDEX order_lines_order ON order_lines (order_id);

CREATE TABLE order_line_modifiers (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id              uuid NOT NULL,
  order_line_id       uuid NOT NULL,
  modifier_option_id  uuid NOT NULL,
  name                text NOT NULL,
  price_delta_cents   bigint NOT NULL,
  FOREIGN KEY (org_id, order_line_id) REFERENCES order_lines(org_id, id),
  FOREIGN KEY (org_id, modifier_option_id) REFERENCES modifier_options(org_id, id)
);

-- Immutable snapshot of the exploded ingredient requirement for each
-- producible line, computed at order time from the pinned versions.
CREATE TABLE order_line_ingredients (
  org_id             uuid NOT NULL,
  order_line_id      uuid NOT NULL,
  inventory_item_id  uuid NOT NULL,
  quantity           numeric(18,3) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (order_line_id, inventory_item_id),
  FOREIGN KEY (org_id, order_line_id) REFERENCES order_lines(org_id, id),
  FOREIGN KEY (org_id, inventory_item_id) REFERENCES inventory_items(org_id, id)
);
CREATE TRIGGER order_line_ingredients_append_only BEFORE UPDATE OR DELETE ON order_line_ingredients
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

CREATE TABLE stock_reservations (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id             uuid NOT NULL,
  location_id        uuid NOT NULL,
  inventory_item_id  uuid NOT NULL,
  order_line_id      uuid NOT NULL,
  quantity           numeric(18,3) NOT NULL CHECK (quantity > 0),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'released')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  closed_at          timestamptz,
  UNIQUE (order_line_id, inventory_item_id),
  CHECK ((status = 'active') = (closed_at IS NULL)),
  FOREIGN KEY (org_id, order_line_id) REFERENCES order_lines(org_id, id),
  FOREIGN KEY (org_id, location_id) REFERENCES stock_locations(org_id, id),
  FOREIGN KEY (org_id, inventory_item_id) REFERENCES inventory_items(org_id, id)
);

CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id              uuid NOT NULL,
  restaurant_id       uuid NOT NULL,
  order_id            uuid NOT NULL,
  method              text NOT NULL CHECK (method IN ('card', 'cash', 'gift_card')),
  provider            text NOT NULL CHECK (provider IN ('sandbox', 'cash')),
  status              text NOT NULL CHECK (status IN ('pending', 'authorized', 'captured', 'failed', 'voided', 'partially_refunded', 'refunded')),
  amount_cents        bigint NOT NULL CHECK (amount_cents > 0),
  -- Tokenised reference only. Full PAN / CVV are never accepted or stored.
  provider_reference  text,
  card_brand          text,
  card_last4          char(4) CHECK (card_last4 ~ '^[0-9]{4}$'),
  failure_reason      text,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  captured_at         timestamptz,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, order_id) REFERENCES orders(org_id, id),
  FOREIGN KEY (org_id, restaurant_id) REFERENCES restaurants(org_id, id)
);
CREATE INDEX payments_order ON payments (order_id);
-- At most one successful payment per order for now (split tender comes later).
CREATE UNIQUE INDEX payments_one_success_per_order ON payments (order_id)
  WHERE status IN ('authorized', 'captured', 'partially_refunded', 'refunded');

-- ---------------------------------------------------------------------------
-- Kitchen
-- ---------------------------------------------------------------------------

CREATE TABLE kitchen_tasks (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id             uuid NOT NULL,
  restaurant_id      uuid NOT NULL,
  order_id           uuid NOT NULL,
  order_line_id      uuid NOT NULL UNIQUE,
  station_id         uuid NOT NULL,
  label              text NOT NULL,
  quantity           integer NOT NULL CHECK (quantity > 0),
  modifiers          text[] NOT NULL DEFAULT '{}',
  instructions       text NOT NULL DEFAULT '',
  status             text NOT NULL CHECK (status IN ('queued', 'in_progress', 'done', 'cancelled')),
  priority           integer NOT NULL DEFAULT 0,
  version            integer NOT NULL DEFAULT 1,
  queued_at          timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  completed_at       timestamptz,
  cancelled_at       timestamptz,
  started_by         uuid,
  completed_by       uuid,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, order_id) REFERENCES orders(org_id, id),
  FOREIGN KEY (org_id, order_line_id) REFERENCES order_lines(org_id, id),
  FOREIGN KEY (org_id, station_id) REFERENCES stations(org_id, id)
);
CREATE INDEX kitchen_tasks_station_queue ON kitchen_tasks (station_id, status, priority DESC, queued_at);
CREATE INDEX kitchen_tasks_order ON kitchen_tasks (order_id);

-- ---------------------------------------------------------------------------
-- Integration: transactional outbox / inbox, idempotency, audit
-- ---------------------------------------------------------------------------

CREATE TABLE restaurant_event_sequences (
  org_id         uuid NOT NULL,
  restaurant_id  uuid PRIMARY KEY,
  last_sequence  bigint NOT NULL DEFAULT 0,
  FOREIGN KEY (org_id, restaurant_id) REFERENCES restaurants(org_id, id)
);

CREATE TABLE outbox_events (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id             uuid NOT NULL,
  restaurant_id      uuid NOT NULL,
  -- Gap-free, store-scoped ordering assigned in the producing transaction.
  store_sequence     bigint NOT NULL,
  aggregate_type     text NOT NULL,
  aggregate_id       uuid NOT NULL,
  aggregate_version  integer NOT NULL,
  event_type         text NOT NULL,
  event_version      integer NOT NULL DEFAULT 1,
  payload            jsonb NOT NULL,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  published_at       timestamptz,
  UNIQUE (restaurant_id, store_sequence),
  FOREIGN KEY (org_id, restaurant_id) REFERENCES restaurants(org_id, id)
);
CREATE INDEX outbox_unpublished ON outbox_events (occurred_at) WHERE published_at IS NULL;

-- Low-latency fan-out for live screens. NOTIFY is delivered only on commit, so
-- listeners never see events from rolled-back transactions. The outbox row
-- remains the durable source of truth; NOTIFY is only a wake-up signal.
CREATE FUNCTION app.notify_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('kitchos_events', json_build_object(
    'id', NEW.id, 'orgId', NEW.org_id, 'restaurantId', NEW.restaurant_id,
    'seq', NEW.store_sequence, 'type', NEW.event_type,
    'aggregateType', NEW.aggregate_type, 'aggregateId', NEW.aggregate_id)::text);
  RETURN NULL;
END
$$;
CREATE TRIGGER outbox_notify AFTER INSERT ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION app.notify_outbox();
CREATE TRIGGER outbox_no_delete BEFORE DELETE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

CREATE TABLE inbox_events (
  consumer      text NOT NULL,
  event_id      uuid NOT NULL,
  org_id        uuid NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE idempotency_keys (
  org_id           uuid NOT NULL REFERENCES organisations(id),
  scope            text NOT NULL,
  key              text NOT NULL CHECK (length(key) BETWEEN 8 AND 128),
  request_hash     text NOT NULL,
  response_status  integer,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, scope, key)
);

CREATE TABLE audit_log (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id           uuid NOT NULL REFERENCES organisations(id),
  restaurant_id    uuid,
  actor_user_id    uuid,
  actor_device_id  uuid,
  action           text NOT NULL,
  entity_type      text NOT NULL,
  entity_id        uuid,
  reason           text,
  data             jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity ON audit_log (entity_type, entity_id);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Pre-tenant lookups (SECURITY DEFINER, narrow, read-only)
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.lookup_login(p_email text)
RETURNS TABLE (user_id uuid, org_id uuid, password_hash text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, org_id, password_hash, status FROM users WHERE lower(email) = lower(p_email)
$$;

CREATE FUNCTION app.lookup_restaurant(p_slug text)
RETURNS TABLE (restaurant_id uuid, org_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, org_id FROM restaurants WHERE slug = p_slug AND status = 'active'
$$;

CREATE FUNCTION app.lookup_order_token(p_token text)
RETURNS TABLE (order_id uuid, org_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, org_id FROM orders WHERE public_token = p_token
$$;

CREATE FUNCTION app.list_public_restaurants()
RETURNS TABLE (slug text, name text, address text, timezone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT slug, name, address, timezone FROM restaurants WHERE status = 'active' ORDER BY name
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organisations USING (id = app.current_org());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'brands', 'regions', 'menus', 'restaurants', 'stations', 'devices', 'users',
    'role_assignments', 'inventory_items', 'stock_locations', 'stock_movements',
    'stock_balances', 'products', 'recipes', 'recipe_versions', 'recipe_lines',
    'menu_versions', 'menu_items', 'combo_components', 'modifier_groups',
    'modifier_options', 'modifier_option_ingredients', 'product_availability',
    'restaurant_order_counters', 'orders', 'order_lines', 'order_line_modifiers',
    'order_line_ingredients', 'stock_reservations', 'payments', 'kitchen_tasks',
    'restaurant_event_sequences', 'outbox_events', 'inbox_events', 'idempotency_keys',
    'audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org())', t);
  END LOOP;
END
$$;
