import type { Tx } from '@kitchos/database';

export interface AuditEntry {
  orgId: string;
  restaurantId?: string | null;
  actorUserId?: string | null;
  actorDeviceId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  reason?: string | null;
  data?: Record<string, unknown>;
}

/** Writes to the append-only audit log inside the caller's transaction. */
export async function audit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx
    .insertInto('audit_log')
    .values({
      org_id: entry.orgId,
      restaurant_id: entry.restaurantId ?? null,
      actor_user_id: entry.actorUserId ?? null,
      actor_device_id: entry.actorDeviceId ?? null,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      reason: entry.reason ?? null,
      data: JSON.stringify(entry.data ?? {}),
    })
    .execute();
}
