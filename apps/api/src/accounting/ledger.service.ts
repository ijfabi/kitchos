import { Injectable } from '@nestjs/common';
import type { Tx } from '@kitchos/database';
import { assertBalanced, type Posting } from '@kitchos/domain';

export interface EntryInput {
  orgId: string;
  restaurantId: string;
  businessDate: string;
  entryType: 'payment_receipt' | 'sale_recognition' | 'refund';
  sourceType: string;
  sourceId: string;
  sourceEventId: string | null;
  description: string;
  postings: readonly Posting[];
}

/**
 * The single path for writing journal entries. Postings are validated as
 * balanced here and again by the database at commit. An entry is unique per
 * (source, entry type), so posting the same fact twice is a no-op.
 */
@Injectable()
export class LedgerService {
  async post(tx: Tx, input: EntryInput): Promise<{ posted: boolean; entryId: string | null }> {
    assertBalanced(input.postings);
    const keys = [...new Set(input.postings.map((p) => p.account))];
    const accounts = await tx
      .selectFrom('accounts')
      .select(['id', 'system_key'])
      .where('system_key', 'in', keys)
      .where('active', '=', true)
      .execute();
    const accountId = new Map(accounts.map((a) => [a.system_key, a.id]));
    const missing = keys.filter((k) => !accountId.has(k));
    if (missing.length > 0) throw new Error(`Chart of accounts is missing: ${missing.join(', ')}`);

    const entry = await tx
      .insertInto('journal_entries')
      .values({
        org_id: input.orgId,
        restaurant_id: input.restaurantId,
        business_date: input.businessDate,
        entry_type: input.entryType,
        source_type: input.sourceType,
        source_id: input.sourceId,
        source_event_id: input.sourceEventId,
        description: input.description,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'source_type', 'source_id', 'entry_type']).doNothing(),
      )
      .returning('id')
      .executeTakeFirst();
    if (!entry) return { posted: false, entryId: null };

    await tx
      .insertInto('journal_lines')
      .values(
        input.postings.map((p) => ({
          org_id: input.orgId,
          entry_id: entry.id,
          account_id: accountId.get(p.account)!,
          debit_cents: p.debitCents,
          credit_cents: p.creditCents,
          memo: p.memo,
        })),
      )
      .execute();
    return { posted: true, entryId: entry.id };
  }
}
