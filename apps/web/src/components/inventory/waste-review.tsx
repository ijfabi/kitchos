'use client';

import type { WasteRecordView, WasteSummary } from '@kitchos/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, EmptyState, Spinner } from '@/components/ui';
import { api, get } from '@/lib/api';
import { money } from '@/lib/format';
import { WASTE_REASON_LABEL, WasteSummaryLine } from './fields';

interface Props {
  restaurantId: string;
  token: string;
  userId: string;
  canReview: boolean;
  canSeeSummary: boolean;
}

export function WasteReview({ restaurantId, token, userId, canReview, canSeeSummary }: Props) {
  const records = useQuery({
    queryKey: ['waste', restaurantId],
    queryFn: ({ signal }) =>
      get<WasteRecordView[]>(
        `/v1/restaurants/${restaurantId}/inventory/waste?limit=100`,
        token,
        signal,
      ),
    refetchInterval: 15_000,
  });
  // Its own query: an old pending record must not drop out behind newer records.
  const pending = useQuery({
    queryKey: ['waste', restaurantId, 'pending'],
    queryFn: ({ signal }) =>
      get<WasteRecordView[]>(
        `/v1/restaurants/${restaurantId}/inventory/waste?status=pending_approval&limit=200`,
        token,
        signal,
      ),
    refetchInterval: 15_000,
  });
  const needsApproval = pending.data ?? [];
  const others = records.data?.filter((w) => w.status !== 'pending_approval') ?? [];

  return (
    <div className="space-y-5">
      {canSeeSummary && <Summary restaurantId={restaurantId} token={token} />}
      {records.isPending || pending.isPending ? (
        <Spinner label="Loading waste" />
      ) : records.isError || pending.isError ? (
        <EmptyState title="Cannot load waste" hint={(records.error ?? pending.error)?.message} />
      ) : (
        <>
          <section aria-label="Needs approval">
            <h2 className="mb-2 font-bold">Needs approval</h2>
            {needsApproval.length === 0 ? (
              <EmptyState className="py-6" title="Nothing waiting for approval" />
            ) : (
              <ul className="space-y-2">
                {needsApproval.map((w) => (
                  <ReviewRow
                    key={w.id}
                    w={w}
                    restaurantId={restaurantId}
                    token={token}
                    userId={userId}
                    canReview={canReview}
                  />
                ))}
              </ul>
            )}
          </section>
          <section aria-label="Recent waste">
            <h2 className="mb-2 font-bold">Recent waste</h2>
            {others.length === 0 ? (
              <EmptyState className="py-6" title="No waste recorded" />
            ) : (
              <ul className="space-y-2">
                {others.map((w) => (
                  <ReviewRow
                    key={w.id}
                    w={w}
                    restaurantId={restaurantId}
                    token={token}
                    userId={userId}
                    canReview={canReview}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function ReviewRow({
  w,
  restaurantId,
  token,
  userId,
  canReview,
}: {
  w: WasteRecordView;
  restaurantId: string;
  token: string;
  userId: string;
  canReview: boolean;
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const review = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      api<WasteRecordView>(`/v1/restaurants/${restaurantId}/inventory/waste/${w.id}/${decision}`, {
        method: 'POST',
        token,
        body: { reason: reason.trim() },
      }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['waste', restaurantId] });
      void qc.invalidateQueries({ queryKey: ['waste-summary', restaurantId] });
      void qc.invalidateQueries({ queryKey: ['balances', restaurantId] });
    },
  });
  // Mirrors the server's rule: anything unreviewed can be rejected; only pending can be approved.
  const open = w.status === 'pending_approval' || w.status === 'recorded';
  const mine = w.recordedById === userId;
  const ok = reason.trim().length >= 3 && !review.isPending;

  return (
    <li data-testid="waste-record" data-status={w.status}>
      <Card className="p-3">
        <WasteSummaryLine w={w} />
        {canReview && open && mine && (
          <p className="mt-2 text-sm text-ink-muted">
            Another manager must review waste you recorded yourself.
          </p>
        )}
        {canReview && open && !mine && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              aria-label="Review reason"
              placeholder="Reason for the decision"
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="h-10 min-w-0 flex-1 rounded-lg border border-line px-3 text-sm"
            />
            {w.status === 'pending_approval' && (
              <Button
                disabled={!ok}
                loading={review.isPending && review.variables === 'approve'}
                onClick={() => review.mutate('approve')}
              >
                Approve
              </Button>
            )}
            <Button
              variant="danger"
              disabled={!ok}
              loading={review.isPending && review.variables === 'reject'}
              onClick={() => review.mutate('reject')}
            >
              Reject
            </Button>
            {review.isError && (
              <p role="alert" className="w-full text-sm text-danger">
                {review.error.message}
              </p>
            )}
          </div>
        )}
      </Card>
    </li>
  );
}

function Summary({ restaurantId, token }: { restaurantId: string; token: string }) {
  const day = useQuery({
    queryKey: ['business-date', restaurantId],
    queryFn: ({ signal }) =>
      get<{ businessDate: string }>(
        `/v1/restaurants/${restaurantId}/accounting/business-date`,
        token,
        signal,
      ),
  });
  const businessDate = day.data?.businessDate;
  const summary = useQuery({
    queryKey: ['waste-summary', restaurantId, businessDate],
    queryFn: ({ signal }) =>
      get<WasteSummary>(
        `/v1/restaurants/${restaurantId}/inventory/waste/summary?from=${businessDate}&to=${businessDate}`,
        token,
        signal,
      ),
    enabled: !!businessDate,
  });
  if (!summary.data) return null;
  const s = summary.data;
  return (
    <section aria-label="Waste today" data-testid="waste-summary">
      <Card className="p-4">
        <h2 className="font-bold">Waste today · {money(s.totalCostCents)}</h2>
        <p className="text-sm text-ink-muted">
          {money(s.deductedDirectlyCents)} taken from stock ·{' '}
          {money(s.reclassifiedFromConsumptionCents)} already used in production
        </p>
        <div className="mt-3 grid gap-4 text-sm sm:grid-cols-3">
          <Breakdown
            title="By reason"
            rows={s.byReason.map((r) => [
              WASTE_REASON_LABEL[r.reason as WasteRecordView['reason']] ?? r.reason,
              r.costCents,
            ])}
          />
          <Breakdown title="By station" rows={s.byStation.map((r) => [r.station, r.costCents])} />
          <Breakdown title="By person" rows={s.byEmployee.map((r) => [r.employee, r.costCents])} />
        </div>
      </Card>
    </section>
  );
}

function Breakdown({ title, rows }: { title: string; rows: [string, number][] }) {
  return (
    <div>
      <h3 className="font-semibold">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-ink-muted">None</p>
      ) : (
        <dl>
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2">
              <dt className="text-ink-muted">{k}</dt>
              <dd className="tabular-nums">{money(v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
