/**
 * Fine-grained permissions. Roles map to permission sets here (RBAC); the
 * scope of each role assignment (organisation / brand / region / restaurant)
 * limits where those permissions apply (ABAC on the restaurant hierarchy).
 */
export const PERMISSIONS = [
  'orders.view',
  'orders.create',
  'orders.handoff',
  'orders.cancel',
  'orders.cancel_after_prep',
  'kitchen.view',
  'kitchen.operate',
  'inventory.view',
  'inventory.adjust',
  'inventory.approve',
  'waste.record',
  'waste.approve',
  'discount.apply',
  'discount.approve',
  'payments.refund',
  'cash.drawer',
  'cash.manage',
  'reports.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const CREW: Permission[] = [
  'orders.view',
  'orders.create',
  'orders.handoff',
  'kitchen.view',
  'kitchen.operate',
  'waste.record',
  'discount.apply',
  'cash.drawer',
];
const SUPERVISOR: Permission[] = [
  ...CREW,
  'orders.cancel',
  'inventory.view',
  'discount.approve',
  'payments.refund',
  'cash.manage',
];
const MANAGER: Permission[] = [
  ...SUPERVISOR,
  'orders.cancel_after_prep',
  'inventory.adjust',
  'inventory.approve',
  'waste.approve',
  'reports.view',
];
const OVERSIGHT: Permission[] = ['orders.view', 'kitchen.view', 'inventory.view', 'reports.view'];

export const ROLE_PERMISSIONS: Record<string, readonly Permission[]> = {
  crew_member: CREW,
  crew_trainer: CREW,
  shift_supervisor: SUPERVISOR,
  assistant_manager: MANAGER,
  restaurant_manager: MANAGER,
  area_manager: OVERSIGHT,
  regional_manager: OVERSIGHT,
  franchise_owner: OVERSIGHT,
  inventory_controller: [
    'inventory.view',
    'inventory.adjust',
    'inventory.approve',
    'waste.record',
    'waste.approve',
  ],
  payroll_administrator: [],
  head_office_administrator: [...PERMISSIONS],
  auditor: OVERSIGHT,
  // Platform staff get no implicit tenant data access; support access must be
  // an explicit, audited, time-boxed grant (not yet implemented).
  platform_administrator: [],
};

export interface RoleAssignment {
  role: string;
  scopeType: 'organisation' | 'brand' | 'region' | 'restaurant';
  scopeId: string;
}

export interface RestaurantScope {
  id: string;
  orgId: string;
  brandId: string;
  regionId: string;
}

export function assignmentCovers(a: RoleAssignment, r: RestaurantScope): boolean {
  switch (a.scopeType) {
    case 'organisation':
      return a.scopeId === r.orgId;
    case 'brand':
      return a.scopeId === r.brandId;
    case 'region':
      return a.scopeId === r.regionId;
    case 'restaurant':
      return a.scopeId === r.id;
  }
}

export function permissionsAt(
  assignments: readonly RoleAssignment[],
  r: RestaurantScope,
): Set<Permission> {
  const out = new Set<Permission>();
  for (const a of assignments) {
    if (!assignmentCovers(a, r)) continue;
    for (const p of ROLE_PERMISSIONS[a.role] ?? []) out.add(p);
  }
  return out;
}
