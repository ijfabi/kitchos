# ADR-0007: Immutable published menu and recipe versions

- Status: Accepted (2026-10-26)

## Decision

- `menu_versions` and `recipe_versions` move `draft → published → retired`. Triggers forbid any
  change to a published version or its children (items, combo components, modifier groups,
  options, option ingredients, recipe lines), except the published → retired status change.
- A menu version **pins** a recipe version for each item and combo component. Changing a recipe
  therefore requires publishing a new menu version — this is the head-office rollout unit.
- An order stores `menu_version_id`; each producible line stores `recipe_version_id`,
  `station_type`, `consumption_point`, and an immutable `order_line_ingredients` snapshot of the
  exploded requirement (base recipe + modifier deltas, clamped at zero, × quantity).
- Restaurant-level operational availability ("86'd" products) is separate, mutable state
  (`product_availability`) and is not versioned config.

## Consequences

- Historical orders, theoretical-usage analytics and audits always see the configuration that
  was in force, even after menus change.
- Store-specific price overrides and effective-dated schedules are future work (FEATURE_MATRIX).
