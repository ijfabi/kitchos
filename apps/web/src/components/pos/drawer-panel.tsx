'use client';

import type { DrawerSessionView, DrawerView } from '@kitchos/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useRef, useState } from 'react';
import { Badge, Button } from '@/components/ui';
import { api, ApiError, get, newIdempotencyKey } from '@/lib/api';
import { dollarsToCents, money } from '@/lib/format';

/** The signed-in user's drawer session at this restaurant, if any is still active. */
export function useMyDrawer(restaurantId: string, token: string, userId: string) {
  const drawers = useQuery({
    queryKey: ['drawers', restaurantId],
    queryFn: ({ signal }) =>
      get<DrawerView[]>(`/v1/restaurants/${restaurantId}/cash/drawers`, token, signal),
    refetchInterval: 30_000,
  });
  const mine = drawers.data?.find((d) => d.activeSession?.openedById === userId) ?? null;
  return { drawers, mine };
}

type Mode = 'idle' | 'safe_drop' | 'paid_in' | 'paid_out' | 'count';
const MOVE_LABEL = { safe_drop: 'Safe drop', paid_in: 'Paid in', paid_out: 'Paid out' } as const;

/**
 * Drawer controls for the POS: open a drawer with a float, record safe drops,
 * paid-ins and (for managers) paid-outs, and close with a blind count — the
 * cashier states the counted cash before seeing what was expected.
 */
export function DrawerPanel({
  restaurantId,
  token,
  userId,
  canManage,
  onClose,
}: {
  restaurantId: string;
  token: string;
  userId: string;
  canManage: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { drawers, mine } = useMyDrawer(restaurantId, token, userId);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<Mode>('idle');
  const [result, setResult] = useState<DrawerSessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One key per movement / count attempt; kept across network errors so a retry never doubles it.
  const key = useRef(newIdempotencyKey());
  const cents = dollarsToCents(amount);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['drawers', restaurantId] });
  const fail = (err: Error) => {
    if (err instanceof ApiError && err.status < 500) key.current = newIdempotencyKey();
    setError(err.message);
  };
  const done = () => {
    key.current = newIdempotencyKey();
    setAmount('');
    setReason('');
    setMode('idle');
    setError(null);
    refresh();
  };

  const open = useMutation({
    mutationFn: () =>
      api<DrawerSessionView>(`/v1/restaurants/${restaurantId}/cash/drawers/${drawerId}/sessions`, {
        method: 'POST',
        token,
        body: { openingFloatCents: cents },
      }),
    onSuccess: done,
    onError: fail,
  });
  const move = useMutation({
    mutationFn: (kind: keyof typeof MOVE_LABEL) =>
      api<DrawerSessionView>(
        `/v1/restaurants/${restaurantId}/cash/sessions/${mine!.activeSession!.id}/movements`,
        {
          method: 'POST',
          token,
          idempotencyKey: key.current,
          body: { kind, amountCents: cents, reason: reason.trim() },
        },
      ),
    onSuccess: done,
    onError: fail,
  });
  const count = useMutation({
    mutationFn: () =>
      api<DrawerSessionView>(
        `/v1/restaurants/${restaurantId}/cash/sessions/${mine!.activeSession!.id}/count`,
        {
          method: 'POST',
          token,
          idempotencyKey: key.current,
          body: { countedCents: cents, notes: reason.trim() || undefined },
        },
      ),
    onSuccess: (res) => {
      setResult(res.data);
      done();
    },
    onError: fail,
  });

  const field = 'h-11 w-full rounded-lg border border-line px-3 text-sm';
  const busy = open.isPending || move.isPending || count.isPending;

  return (
    <section aria-label="Cash drawer" className="space-y-3 rounded-xl border border-line p-3">
      <div className="flex items-center justify-between">
        <h3 className="font-bold">Cash drawer</h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Done
        </Button>
      </div>

      {result && (
        <div role="status" className="rounded-lg bg-canvas p-3 text-sm" data-testid="count-result">
          <p className="font-semibold">
            {result.drawerName} counted {money(result.countedCents ?? 0)}
          </p>
          <p>
            Expected {money(result.expected?.expectedCents ?? 0)} · variance{' '}
            <span
              className={clsx('font-bold', result.varianceCents === 0 ? 'text-ok' : 'text-danger')}
            >
              {money(result.varianceCents ?? 0)}
            </span>
          </p>
          <p className="text-ink-muted">
            {result.status === 'closed'
              ? 'Drawer closed.'
              : 'Variance is over the limit: a manager must approve before the drawer is closed.'}
          </p>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {drawers.isPending ? (
        <p className="text-sm text-ink-muted">Loading drawers…</p>
      ) : !mine ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (drawerId && cents !== null && !busy) open.mutate();
          }}
        >
          <p className="text-sm text-ink-muted">Open a drawer to take cash.</p>
          <div className="grid grid-cols-2 gap-2">
            {(drawers.data ?? []).map((d) => (
              <button
                key={d.id}
                type="button"
                disabled={!!d.activeSession}
                aria-pressed={drawerId === d.id}
                onClick={() => setDrawerId(d.id)}
                className={clsx(
                  'rounded-lg border px-3 py-2 text-left text-sm disabled:opacity-50',
                  drawerId === d.id ? 'border-brand bg-brand-soft' : 'border-line',
                )}
              >
                <span className="block font-semibold">{d.name}</span>
                <span className="text-xs text-ink-muted">
                  {d.activeSession ? `In use · ${d.activeSession.openedBy}` : 'Free'}
                </span>
              </button>
            ))}
          </div>
          <label className="block text-sm">
            <span className="font-medium">Opening float</span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="200.00"
              className={clsx(field, 'mt-1')}
            />
          </label>
          <Button
            type="submit"
            size="lg"
            className="w-full"
            loading={open.isPending}
            disabled={!drawerId || cents === null}
          >
            Open drawer
          </Button>
        </form>
      ) : mine.activeSession!.status !== 'open' ? (
        <p className="text-sm">
          <Badge tone="warn">Awaiting approval</Badge> {mine.name} was counted with a variance over
          the limit. A manager must approve it before you can open a drawer again.
        </p>
      ) : mode === 'idle' ? (
        <div className="space-y-2">
          <p className="text-sm">
            <Badge tone="ok">Open</Badge> <span className="font-semibold">{mine.name}</span>
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => setMode('safe_drop')}>
              Safe drop
            </Button>
            <Button variant="secondary" onClick={() => setMode('paid_in')}>
              Paid in
            </Button>
            {canManage && (
              <Button variant="secondary" onClick={() => setMode('paid_out')}>
                Paid out
              </Button>
            )}
            <Button variant="danger" onClick={() => setMode('count')}>
              Count &amp; close
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-2"
          aria-label={mode === 'count' ? 'Blind count' : MOVE_LABEL[mode]}
          onSubmit={(e) => {
            e.preventDefault();
            if (cents === null || busy) return;
            if (mode === 'count') count.mutate();
            else if (reason.trim().length >= 3) move.mutate(mode);
          }}
        >
          <p className="text-sm font-semibold">
            {mode === 'count' ? 'Count the drawer' : MOVE_LABEL[mode]}
          </p>
          {mode === 'count' && (
            <p className="text-xs text-ink-muted">
              Count every note and coin, then enter the total. The expected amount is shown only
              after you submit.
            </p>
          )}
          <input
            inputMode="decimal"
            aria-label={mode === 'count' ? 'Counted cash' : 'Amount'}
            autoFocus
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className={field}
          />
          <input
            aria-label={mode === 'count' ? 'Notes' : 'Reason'}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={mode === 'count' ? 'Notes (optional)' : 'Reason'}
            maxLength={mode === 'count' ? 500 : 200}
            className={field}
          />
          <div className="grid grid-cols-[auto_1fr] gap-2">
            <Button type="button" variant="secondary" onClick={() => setMode('idle')}>
              Back
            </Button>
            <Button
              type="submit"
              loading={busy}
              disabled={cents === null || (mode !== 'count' && reason.trim().length < 3)}
            >
              {mode === 'count' ? 'Submit count' : `Record ${MOVE_LABEL[mode].toLowerCase()}`}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
