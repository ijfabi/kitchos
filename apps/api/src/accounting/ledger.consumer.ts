import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@kitchos/database';
import {
  inclusiveTax,
  paymentReceiptPostings,
  refundPostings,
  saleRecognitionPostings,
} from '@kitchos/domain';
import { sql } from 'kysely';
import { LedgerService } from './ledger.service.ts';

export interface ConsumedEvent {
  id: string;
  orgId: string;
  restaurantId: string;
  eventType: string;
  aggregateId: string;
}

export interface EventConsumer {
  readonly name: string;
  readonly eventTypes: readonly string[];
  handle(tx: Tx, event: ConsumedEvent): Promise<void>;
}

/**
 * Posts the double-entry journal from domain events. Facts are re-read from
 * the authoritative tables (never trusted from the event payload):
 *   payment.captured -> payment receipt (deposit liability, cash rounding)
 *   order.completed  -> sale recognition (revenue, discounts, GST)
 *   payment.refunded -> refund (deposit returned, or sales return with GST share)
 */
@Injectable()
export class LedgerConsumer implements EventConsumer {
  readonly name = 'ledger';
  readonly eventTypes = ['payment.captured', 'order.completed', 'payment.refunded'] as const;

  constructor(@Inject(LedgerService) private readonly ledger: LedgerService) {}

  async handle(tx: Tx, event: ConsumedEvent): Promise<void> {
    if (event.eventType === 'payment.captured') return this.paymentCaptured(tx, event);
    if (event.eventType === 'order.completed') return this.orderCompleted(tx, event);
    if (event.eventType === 'payment.refunded') return this.paymentRefunded(tx, event);
  }

  private async paymentRefunded(tx: Tx, event: ConsumedEvent): Promise<void> {
    const r = await tx
      .selectFrom('refunds as f')
      .innerJoin('orders as o', 'o.id', 'f.order_id')
      .select([
        'f.id',
        'f.order_id',
        'f.restaurant_id',
        'f.method',
        'f.treatment',
        'f.amount_cents',
        'f.refunded_before_cents',
        'f.cash_rounding_cents',
        'f.created_at',
        'o.order_number',
        'o.total_cents',
        'o.tax_cents',
        sql<string>`app.business_date(f.restaurant_id, f.created_at)::text`.as('business_date'),
      ])
      .where('f.id', '=', event.aggregateId)
      .executeTakeFirst();
    if (!r) throw new Error(`refund ${event.aggregateId} not found`);
    await this.ledger.post(tx, {
      orgId: event.orgId,
      restaurantId: r.restaurant_id,
      businessDate: r.business_date,
      entryType: 'refund',
      sourceType: 'refund',
      sourceId: r.id,
      sourceEventId: event.id,
      description: `${r.treatment === 'sales_return' ? 'Sales return' : 'Deposit refund'}: order #${r.order_number}`,
      postings: refundPostings({
        method: r.method as 'card' | 'cash',
        treatment: r.treatment as 'deposit_release' | 'sales_return',
        amountCents: r.amount_cents,
        cashRoundingCents: r.cash_rounding_cents,
        orderTotalCents: r.total_cents,
        orderTaxCents: r.tax_cents,
        // Captured under the payment lock when the refund was made (not inferred from ids or clocks).
        previouslyRefundedCents: r.refunded_before_cents,
      }),
    });
  }

  private async paymentCaptured(tx: Tx, event: ConsumedEvent): Promise<void> {
    const p = await tx
      .selectFrom('payments as p')
      .innerJoin('orders as o', 'o.id', 'p.order_id')
      .select([
        'p.id',
        'p.restaurant_id',
        'p.method',
        'p.amount_cents',
        'p.cash_rounding_cents',
        'o.order_number',
        sql<string>`app.business_date(p.restaurant_id, p.captured_at)::text`.as('business_date'),
      ])
      .where('p.id', '=', event.aggregateId)
      .executeTakeFirst();
    if (!p) throw new Error(`payment ${event.aggregateId} not found`);
    if (p.method !== 'cash' && p.method !== 'card')
      throw new Error(`unsupported payment method ${p.method}`);
    await this.ledger.post(tx, {
      orgId: event.orgId,
      restaurantId: p.restaurant_id,
      businessDate: p.business_date,
      entryType: 'payment_receipt',
      sourceType: 'payment',
      sourceId: p.id,
      sourceEventId: event.id,
      description: `${p.method === 'cash' ? 'Cash' : 'Card'} payment: order #${p.order_number}`,
      postings: paymentReceiptPostings({
        method: p.method,
        amountCents: p.amount_cents,
        cashRoundingCents: p.cash_rounding_cents,
      }),
    });
  }

  private async orderCompleted(tx: Tx, event: ConsumedEvent): Promise<void> {
    const o = await tx
      .selectFrom('orders')
      .select([
        'id',
        'restaurant_id',
        'order_number',
        'status',
        'subtotal_cents',
        'discount_cents',
        'total_cents',
        'tax_cents',
        'tax_rate_bp',
        sql<string>`app.business_date(restaurant_id, completed_at)::text`.as('business_date'),
      ])
      .where('id', '=', event.aggregateId)
      .executeTakeFirst();
    if (!o) throw new Error(`order ${event.aggregateId} not found`);
    if (o.status !== 'completed') throw new Error(`order ${o.id} is ${o.status}, not completed`);
    const taxable = await tx
      .selectFrom('order_lines')
      .select((eb) =>
        eb.fn.coalesce(eb.fn.sum<number>('line_total_cents'), sql<number>`0`).as('cents'),
      )
      .where('order_id', '=', o.id)
      .where('kind', 'in', ['item', 'combo'])
      .where('taxable', '=', true)
      .executeTakeFirstOrThrow();
    const taxableSubtotal = Number(taxable.cents);
    // Defensive cross-check: the stored GST must equal what pricing would produce.
    if (o.discount_cents === 0 && o.tax_cents !== inclusiveTax(taxableSubtotal, o.tax_rate_bp)) {
      throw new Error(`order ${o.id} GST ${o.tax_cents} does not match its lines`);
    }
    await this.ledger.post(tx, {
      orgId: event.orgId,
      restaurantId: o.restaurant_id,
      businessDate: o.business_date,
      entryType: 'sale_recognition',
      sourceType: 'order',
      sourceId: o.id,
      sourceEventId: event.id,
      description: `Sale: order #${o.order_number}`,
      postings: saleRecognitionPostings({
        subtotalCents: o.subtotal_cents,
        discountCents: o.discount_cents,
        totalCents: o.total_cents,
        taxCents: o.tax_cents,
        taxableSubtotalCents: taxableSubtotal,
        taxRateBasisPoints: o.tax_rate_bp,
      }),
    });
  }
}
