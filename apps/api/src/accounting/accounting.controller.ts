import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { withTenant, type Database } from '@kitchos/database';
import type { JournalEntryView, LedgerReconciliation, TrialBalance } from '@kitchos/contracts';
import { sql } from 'kysely';
import { z } from 'zod';
import { Principal, RequirePermission, StaffAuthGuard } from '../auth/auth.guard.ts';
import type { StaffPrincipal } from '../auth/auth.service.ts';
import { DB } from '../infra/tokens.ts';
import { BusinessDay, UuidParam, ZodPipe } from '../infra/zod.ts';
import { ReconciliationService } from './reconciliation.service.ts';

const DateRange = z
  .object({
    from: BusinessDay,
    to: BusinessDay,
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .refine((q) => q.from <= q.to, 'from must not be after to');
const OneDay = z.object({ businessDate: BusinessDay });

const num = (v: unknown) => Number(v ?? 0);

/** Read-only views over the journal for one restaurant. */
@Controller('v1/restaurants/:restaurantId/accounting')
@UseGuards(StaffAuthGuard)
export class AccountingController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ReconciliationService) private readonly reconciler: ReconciliationService,
  ) {}

  /** Today's business date in the restaurant's timezone and cutoff (the default for reports). */
  @Get('business-date')
  @RequirePermission('reports.view')
  async businessDate(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Principal() p: StaffPrincipal,
  ): Promise<{ businessDate: string }> {
    const { rows } = await withTenant(this.db, p, (tx) =>
      sql<{ d: string }>`select app.business_date(${restaurantId}::uuid, now())::text as d`.execute(
        tx,
      ),
    );
    return { businessDate: rows[0]!.d };
  }

  @Get('journal')
  @RequirePermission('reports.view')
  async journal(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Query(new ZodPipe(DateRange)) q: z.output<typeof DateRange>,
    @Principal() p: StaffPrincipal,
  ): Promise<JournalEntryView[]> {
    return withTenant(this.db, p, async (tx) => {
      const entries = await tx
        .selectFrom('journal_entries')
        .select([
          'id',
          'business_date',
          'entry_type',
          'description',
          'source_type',
          'source_id',
          'posted_at',
        ])
        .where('restaurant_id', '=', restaurantId)
        .where('business_date', '>=', q.from)
        .where('business_date', '<=', q.to)
        .orderBy('posted_at', 'desc')
        .orderBy('id', 'desc')
        .limit(q.limit)
        .execute();
      const lines = entries.length
        ? await tx
            .selectFrom('journal_lines as l')
            .innerJoin('accounts as a', 'a.id', 'l.account_id')
            .select(['l.entry_id', 'a.code', 'a.name', 'l.debit_cents', 'l.credit_cents', 'l.memo'])
            .where(
              'l.entry_id',
              'in',
              entries.map((e) => e.id),
            )
            .orderBy('a.code')
            .execute()
        : [];
      return entries.map((e) => ({
        id: e.id,
        businessDate: e.business_date,
        entryType: e.entry_type,
        description: e.description,
        sourceType: e.source_type,
        sourceId: e.source_id,
        postedAt: e.posted_at.toISOString(),
        lines: lines
          .filter((l) => l.entry_id === e.id)
          .map((l) => ({
            accountCode: l.code,
            accountName: l.name,
            debitCents: l.debit_cents,
            creditCents: l.credit_cents,
            memo: l.memo,
          })),
      }));
    });
  }

  @Get('trial-balance')
  @RequirePermission('reports.view')
  async trialBalance(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Query(new ZodPipe(DateRange)) q: z.output<typeof DateRange>,
    @Principal() p: StaffPrincipal,
  ): Promise<TrialBalance> {
    return withTenant(this.db, p, async (tx) => {
      const rows = await tx
        .selectFrom('accounts as a')
        .leftJoin(
          (eb) =>
            eb
              .selectFrom('journal_lines as l')
              .innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
              .select([
                'l.account_id',
                (x) => x.fn.sum<number>('l.debit_cents').as('debit'),
                (x) => x.fn.sum<number>('l.credit_cents').as('credit'),
              ])
              .where('e.restaurant_id', '=', restaurantId)
              .where('e.business_date', '>=', q.from)
              .where('e.business_date', '<=', q.to)
              .groupBy('l.account_id')
              .as('t'),
          (join) => join.onRef('t.account_id', '=', 'a.id'),
        )
        .select(['a.code', 'a.name', 'a.type', 'a.normal_balance', 't.debit', 't.credit'])
        // Inactive accounts still appear while they carry postings, or the totals would not tie.
        .where((w) => w.or([w('a.active', '=', true), w('t.account_id', 'is not', null)]))
        .orderBy('a.code')
        .execute();
      const accounts = rows.map((r) => {
        const debit = num(r.debit);
        const credit = num(r.credit);
        return {
          code: r.code,
          name: r.name,
          type: r.type,
          debitCents: debit,
          creditCents: credit,
          balanceCents: r.normal_balance === 'debit' ? debit - credit : credit - debit,
        };
      });
      const totalDebitCents = accounts.reduce((s, a) => s + a.debitCents, 0);
      const totalCreditCents = accounts.reduce((s, a) => s + a.creditCents, 0);
      return {
        from: q.from,
        to: q.to,
        accounts,
        totalDebitCents,
        totalCreditCents,
        balanced: totalDebitCents === totalCreditCents,
      };
    });
  }

  /**
   * Reconciles the journal with its sources for one business day: net sales
   * and GST of handed-over orders vs posted sale entries, and captured
   * payments vs posted receipts, plus the ledger consumer's backlog.
   */
  @Get('reconciliation')
  @RequirePermission('reports.view')
  async reconciliation(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Query(new ZodPipe(OneDay)) q: z.output<typeof OneDay>,
    @Principal() p: StaffPrincipal,
  ): Promise<LedgerReconciliation> {
    return withTenant(this.db, p, (tx) => this.reconciler.forDay(tx, restaurantId, q.businessDate));
  }
}
