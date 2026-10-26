import { DomainError } from './errors.ts';

export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export interface StateMachine<S extends string> {
  readonly name: string;
  readonly states: readonly S[];
  canTransition(from: S, to: S): boolean;
  assertTransition(from: S, to: S): void;
  isTerminal(state: S): boolean;
}

export function defineStateMachine<S extends string>(
  name: string,
  table: TransitionTable<S>,
): StateMachine<S> {
  const states = Object.keys(table) as S[];
  return {
    name,
    states,
    canTransition: (from, to) => table[from].includes(to),
    assertTransition(from, to) {
      if (!table[from].includes(to)) {
        throw new DomainError(
          'INVALID_STATE_TRANSITION',
          `${name}: cannot move from ${from} to ${to}`,
          {
            machine: name,
            from,
            to,
          },
        );
      }
    },
    isTerminal: (state) => table[state].length === 0,
  };
}

/**
 * Order lifecycle. Payment state is deliberately NOT part of this machine
 * (invariant 14): an order is accepted once payment is secured or the channel
 * policy allows pay-later, but the payment has its own machine below.
 */
export const ORDER_STATUSES = [
  'pending_payment',
  'accepted',
  'in_preparation',
  'ready',
  'completed',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const orderStateMachine = defineStateMachine<OrderStatus>('order', {
  pending_payment: ['accepted', 'cancelled'],
  accepted: ['in_preparation', 'ready', 'cancelled'],
  in_preparation: ['ready', 'cancelled'],
  ready: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
});

export const PAYMENT_STATUSES = [
  'pending',
  'authorized',
  'captured',
  'failed',
  'voided',
  'partially_refunded',
  'refunded',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const paymentStateMachine = defineStateMachine<PaymentStatus>('payment', {
  pending: ['authorized', 'captured', 'failed'],
  authorized: ['captured', 'voided', 'failed'],
  captured: ['partially_refunded', 'refunded'],
  partially_refunded: ['partially_refunded', 'refunded'],
  failed: [],
  voided: [],
  refunded: [],
});

export const KITCHEN_TASK_STATUSES = ['queued', 'in_progress', 'done', 'cancelled'] as const;
export type KitchenTaskStatus = (typeof KITCHEN_TASK_STATUSES)[number];

export const kitchenTaskStateMachine = defineStateMachine<KitchenTaskStatus>('kitchen_task', {
  queued: ['in_progress', 'cancelled'],
  in_progress: ['done', 'cancelled'],
  done: [],
  cancelled: [],
});
