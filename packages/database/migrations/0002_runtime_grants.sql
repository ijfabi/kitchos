-- Least-privilege grants for the runtime role. The role itself is created by
-- infrastructure (docker init script locally, Terraform in AWS, the test
-- harness in CI) so that credentials never live in migrations.

GRANT USAGE ON SCHEMA public, app TO kitchos_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO kitchos_app;

-- Read-mostly reference and configuration data. Head-office write paths get
-- explicit grants when their APIs are built.
GRANT SELECT ON organisations, brands, regions, menus, restaurants, stations, devices,
  inventory_items, stock_locations, products, recipes, recipe_versions, recipe_lines,
  menu_versions, menu_items, combo_components, modifier_groups, modifier_options,
  modifier_option_ingredients
TO kitchos_app;

GRANT SELECT ON users, role_assignments TO kitchos_app;

GRANT SELECT, INSERT, UPDATE ON product_availability TO kitchos_app;

-- Operational, mutable aggregates (state machines with version columns).
GRANT SELECT, INSERT, UPDATE ON orders, payments, kitchen_tasks, stock_reservations,
  restaurant_order_counters, restaurant_event_sequences, idempotency_keys
TO kitchos_app;

-- Immutable once written.
GRANT SELECT, INSERT ON order_lines, order_line_modifiers, order_line_ingredients,
  stock_movements, audit_log, inbox_events
TO kitchos_app;

GRANT SELECT, INSERT ON outbox_events TO kitchos_app;
GRANT UPDATE (published_at) ON outbox_events TO kitchos_app;

-- on_hand is changed only by the SECURITY DEFINER movement trigger.
GRANT SELECT ON stock_balances TO kitchos_app;
GRANT UPDATE (reserved, updated_at) ON stock_balances TO kitchos_app;
-- Allows creating an empty balance row (on_hand defaults to 0) to hold a reservation.
GRANT INSERT (org_id, location_id, inventory_item_id, reserved) ON stock_balances TO kitchos_app;
