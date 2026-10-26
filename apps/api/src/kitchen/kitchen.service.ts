import { Inject, Injectable } from '@nestjs/common';
import { withTenant, type Database, type Tx } from '@kitchos/database';
import type { KitchenTaskView, StationView } from '@kitchos/contracts';
import {
  DomainError,
  kitchenTaskStateMachine,
  orderStateMachine,
  type KitchenTaskStatus,
  type OrderStatus,
} from '@kitchos/domain';
import { sql } from 'kysely';
import { appendEvents, type DomainEventInput } from '../events/outbox.ts';
import { ApiException, notFound } from '../infra/http-errors.ts';
import { DB } from '../infra/tokens.ts';
import { InventoryService, type Actor } from '../inventory/inventory.service.ts';

interface StationRow {
  id: string;
  code: string;
  name: string;
  station_types: string[];
}

export interface TaskCommandContext {
  orgId: string;
  restaurantId: string;
  actor: Actor;
}

/** Picks the first active station (by display order) that prepares `stationType`, else the expo station. */
export function routeToStation(
  stations: readonly StationRow[],
  stationType: string,
): StationRow | undefined {
  return (
    stations.find((s) => s.station_types.includes(stationType)) ??
    stations.find((s) => s.station_types.includes('expo'))
  );
}

@Injectable()
export class KitchenService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(InventoryService) private readonly inventory: InventoryService,
  ) {}

  async activeStations(tx: Tx, restaurantId: string): Promise<StationRow[]> {
    return tx
      .selectFrom('stations')
      .select(['id', 'code', 'name', 'station_types'])
      .where('restaurant_id', '=', restaurantId)
      .where('active', '=', true)
      .orderBy('display_order')
      .execute();
  }

  /**
   * Creates one kitchen task per producible order line, routed to its station.
   * Called inside the transaction that accepts the order. order_line_id is
   * unique on kitchen_tasks, so a task can never be created twice for a line.
   */
  async createTasksForOrder(
    tx: Tx,
    args: { orgId: string; restaurantId: string; orderId: string },
  ): Promise<DomainEventInput[]> {
    const stations = await this.activeStations(tx, args.restaurantId);
    const lines = await tx
      .selectFrom('order_lines as l')
      .leftJoin('order_lines as parent', 'parent.id', 'l.parent_line_id')
      .innerJoin('recipe_versions as rv', 'rv.id', 'l.recipe_version_id')
      .select([
        'l.id',
        'l.name',
        'l.quantity',
        'l.station_type',
        'rv.instructions',
        'parent.name as parent_name',
      ])
      .where('l.order_id', '=', args.orderId)
      .where('l.kind', 'in', ['item', 'component'])
      .orderBy('l.line_no')
      .orderBy('l.id')
      .execute();
    const modifiers = lines.length
      ? await tx
          .selectFrom('order_line_modifiers')
          .select(['order_line_id', 'name'])
          .where(
            'order_line_id',
            'in',
            lines.map((l) => l.id),
          )
          .execute()
      : [];

    const events: DomainEventInput[] = [];
    for (const line of lines) {
      const station = routeToStation(stations, line.station_type!);
      if (!station) {
        throw new ApiException(
          409,
          'NO_STATION_AVAILABLE',
          `No active station can prepare ${line.name}`,
        );
      }
      const task = await tx
        .insertInto('kitchen_tasks')
        .values({
          org_id: args.orgId,
          restaurant_id: args.restaurantId,
          order_id: args.orderId,
          order_line_id: line.id,
          station_id: station.id,
          label: line.parent_name ? `${line.name} (${line.parent_name})` : line.name,
          quantity: line.quantity,
          modifiers: modifiers.filter((m) => m.order_line_id === line.id).map((m) => m.name),
          instructions: line.instructions,
          status: 'queued',
        })
        .returning(['id', 'version'])
        .executeTakeFirstOrThrow();
      events.push({
        orgId: args.orgId,
        restaurantId: args.restaurantId,
        aggregateType: 'kitchen_task',
        aggregateId: task.id,
        aggregateVersion: task.version,
        eventType: 'kitchen.task.queued',
        payload: {
          orderId: args.orderId,
          orderLineId: line.id,
          stationId: station.id,
          stationCode: station.code,
        },
      });
    }
    return events;
  }

  async startTask(
    ctx: TaskCommandContext,
    taskId: string,
    expectedVersion?: number,
  ): Promise<KitchenTaskView> {
    return withTenant(this.db, ctx, async (tx) => {
      const { task, order } = await this.lockTaskAndOrder(tx, ctx.restaurantId, taskId);
      if (task.status === 'in_progress') return this.view(tx, taskId); // idempotent repeat
      this.checkVersion(task, expectedVersion);
      const events = await this.transitionToStarted(tx, ctx, task, order);
      await appendEvents(tx, events);
      return this.view(tx, taskId);
    });
  }

  async completeTask(
    ctx: TaskCommandContext,
    taskId: string,
    expectedVersion?: number,
  ): Promise<KitchenTaskView> {
    return withTenant(this.db, ctx, async (tx) => {
      const { task, order } = await this.lockTaskAndOrder(tx, ctx.restaurantId, taskId);
      if (task.status === 'done') return this.view(tx, taskId); // idempotent repeat
      this.checkVersion(task, expectedVersion);
      const events: DomainEventInput[] = [];
      let current = task;
      let orderStatus = order.status;
      if (current.status === 'queued') {
        // Bumping straight from the queue still passes through "started" so
        // task_started consumption is never skipped.
        events.push(...(await this.transitionToStarted(tx, ctx, current, order)));
        current = { ...current, status: 'in_progress', version: current.version + 1 };
        if (orderStatus === 'accepted') orderStatus = 'in_preparation';
      }
      kitchenTaskStateMachine.assertTransition(current.status, 'done');
      const updated = await tx
        .updateTable('kitchen_tasks')
        .set({
          status: 'done',
          completed_at: sql`now()`,
          completed_by: ctx.actor.userId ?? null,
          version: current.version + 1,
        })
        .where('id', '=', taskId)
        .where('version', '=', current.version)
        .returning('version')
        .executeTakeFirst();
      if (!updated) throw new DomainError('CONCURRENT_MODIFICATION', 'Task changed concurrently');
      if (task.consumption_point === 'task_completed') {
        await this.inventory.consumeLine(tx, { ...ctx, orderLineId: task.order_line_id });
      }
      events.push(
        this.taskEvent(ctx, taskId, updated.version, 'kitchen.task.completed', task.order_id),
      );

      const outstanding = await tx
        .selectFrom('kitchen_tasks')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('order_id', '=', task.order_id)
        .where('status', 'in', ['queued', 'in_progress'])
        .executeTakeFirstOrThrow();
      if (
        Number(outstanding.n) === 0 &&
        (orderStatus === 'accepted' || orderStatus === 'in_preparation')
      ) {
        events.push(await this.setOrderStatus(tx, ctx, task.order_id, orderStatus, 'ready'));
      }
      await appendEvents(tx, events);
      return this.view(tx, taskId);
    });
  }

  private async transitionToStarted(
    tx: Tx,
    ctx: TaskCommandContext,
    task: LockedTask,
    order: { id: string; status: OrderStatus },
  ): Promise<DomainEventInput[]> {
    kitchenTaskStateMachine.assertTransition(task.status, 'in_progress');
    const updated = await tx
      .updateTable('kitchen_tasks')
      .set({
        status: 'in_progress',
        started_at: sql`now()`,
        started_by: ctx.actor.userId ?? null,
        version: task.version + 1,
      })
      .where('id', '=', task.id)
      .where('version', '=', task.version)
      .returning('version')
      .executeTakeFirst();
    if (!updated) throw new DomainError('CONCURRENT_MODIFICATION', 'Task changed concurrently');
    if (task.consumption_point === 'task_started') {
      await this.inventory.consumeLine(tx, { ...ctx, orderLineId: task.order_line_id });
    }
    const events = [
      this.taskEvent(ctx, task.id, updated.version, 'kitchen.task.started', task.order_id),
    ];
    if (order.status === 'accepted') {
      events.push(await this.setOrderStatus(tx, ctx, order.id, 'accepted', 'in_preparation'));
    }
    return events;
  }

  private async setOrderStatus(
    tx: Tx,
    ctx: TaskCommandContext,
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
  ): Promise<DomainEventInput> {
    orderStateMachine.assertTransition(from, to);
    const stamp = to === 'ready' ? { ready_at: sql<Date>`now()` } : {};
    const row = await tx
      .updateTable('orders')
      .set((eb) => ({ status: to, version: eb('version', '+', 1), ...stamp }))
      .where('id', '=', orderId)
      .where('status', '=', from)
      .returning('version')
      .executeTakeFirst();
    if (!row) throw new DomainError('CONCURRENT_MODIFICATION', 'Order changed concurrently');
    return {
      orgId: ctx.orgId,
      restaurantId: ctx.restaurantId,
      aggregateType: 'order',
      aggregateId: orderId,
      aggregateVersion: row.version,
      eventType: `order.${to}`,
      payload: { from, to },
    };
  }

  private taskEvent(
    ctx: TaskCommandContext,
    taskId: string,
    version: number,
    type: string,
    orderId: string,
  ): DomainEventInput {
    return {
      orgId: ctx.orgId,
      restaurantId: ctx.restaurantId,
      aggregateType: 'kitchen_task',
      aggregateId: taskId,
      aggregateVersion: version,
      eventType: type,
      payload: { orderId, actorUserId: ctx.actor.userId ?? null },
    };
  }

  private checkVersion(task: LockedTask, expectedVersion: number | undefined): void {
    if (expectedVersion !== undefined && expectedVersion !== task.version) {
      throw new DomainError(
        'CONCURRENT_MODIFICATION',
        'Task was changed by someone else; refresh and retry',
        {
          expectedVersion,
          actualVersion: task.version,
        },
      );
    }
  }

  /** Locks order then task (the same order every command uses) to avoid deadlocks. */
  private async lockTaskAndOrder(
    tx: Tx,
    restaurantId: string,
    taskId: string,
  ): Promise<{ task: LockedTask; order: { id: string; status: OrderStatus } }> {
    const peek = await tx
      .selectFrom('kitchen_tasks')
      .select('order_id')
      .where('id', '=', taskId)
      .where('restaurant_id', '=', restaurantId)
      .executeTakeFirst();
    if (!peek) throw notFound('Kitchen task');
    const order = await tx
      .selectFrom('orders')
      .select(['id', 'status'])
      .where('id', '=', peek.order_id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const task = await tx
      .selectFrom('kitchen_tasks as t')
      .innerJoin('order_lines as l', 'l.id', 't.order_line_id')
      .select([
        't.id',
        't.order_id',
        't.order_line_id',
        't.status',
        't.version',
        'l.consumption_point',
      ])
      .where('t.id', '=', taskId)
      .forUpdate('t')
      .executeTakeFirstOrThrow();
    return {
      task: { ...task, status: task.status as KitchenTaskStatus },
      order: { id: order.id, status: order.status as OrderStatus },
    };
  }

  // ------------------------------------------------------------- queries

  async listStations(ctx: { orgId: string }, restaurantId: string): Promise<StationView[]> {
    return withTenant(this.db, ctx, async (tx) =>
      (await this.activeStations(tx, restaurantId)).map((s) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        stationTypes: s.station_types,
      })),
    );
  }

  async listTasks(
    ctx: { orgId: string },
    restaurantId: string,
    filter: { stationCode?: string; includeRecentDoneMinutes?: number },
  ): Promise<KitchenTaskView[]> {
    return withTenant(this.db, ctx, async (tx) => {
      let q = this.taskQuery(tx)
        .where('t.restaurant_id', '=', restaurantId)
        .where((eb) =>
          eb.or([
            eb('t.status', 'in', ['queued', 'in_progress']),
            eb.and([
              eb('t.status', '=', 'done'),
              eb(
                't.completed_at',
                '>',
                sql<Date>`now() - make_interval(mins => ${filter.includeRecentDoneMinutes ?? 0})`,
              ),
            ]),
          ]),
        )
        .orderBy('t.priority', 'desc')
        .orderBy('t.queued_at')
        .orderBy('t.id');
      if (filter.stationCode) q = q.where('s.code', '=', filter.stationCode);
      return (await q.execute()).map(toTaskView);
    });
  }

  private taskQuery(tx: Tx) {
    return tx
      .selectFrom('kitchen_tasks as t')
      .innerJoin('orders as o', 'o.id', 't.order_id')
      .innerJoin('stations as s', 's.id', 't.station_id')
      .select([
        't.id',
        't.order_id',
        't.station_id',
        't.label',
        't.quantity',
        't.modifiers',
        't.instructions',
        't.status',
        't.version',
        't.queued_at',
        't.started_at',
        't.completed_at',
        'o.order_number',
        'o.fulfilment_type',
        'o.customer_name',
        's.code as station_code',
      ]);
  }

  private async view(tx: Tx, taskId: string): Promise<KitchenTaskView> {
    return toTaskView(
      await this.taskQuery(tx).where('t.id', '=', taskId).executeTakeFirstOrThrow(),
    );
  }
}

interface LockedTask {
  id: string;
  order_id: string;
  order_line_id: string;
  status: KitchenTaskStatus;
  version: number;
  consumption_point: string | null;
}

function toTaskView(r: {
  id: string;
  order_id: string;
  station_id: string;
  label: string;
  quantity: number;
  modifiers: string[];
  instructions: string;
  status: string;
  version: number;
  queued_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  order_number: number;
  fulfilment_type: string;
  customer_name: string | null;
  station_code: string;
}): KitchenTaskView {
  return {
    id: r.id,
    orderId: r.order_id,
    orderNumber: r.order_number,
    fulfilmentType: r.fulfilment_type,
    customerName: r.customer_name,
    stationId: r.station_id,
    stationCode: r.station_code,
    label: r.label,
    quantity: r.quantity,
    modifiers: r.modifiers,
    instructions: r.instructions,
    status: r.status as KitchenTaskView['status'],
    version: r.version,
    queuedAt: r.queued_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    completedAt: r.completed_at?.toISOString() ?? null,
  };
}
