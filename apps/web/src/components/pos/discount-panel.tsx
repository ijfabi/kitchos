'use client';

import type { OrderView, OverrideResponse } from '@kitchos/contracts';
import { clsx } from 'clsx';
import { ShieldCheck } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { dollarsToCents, money } from '@/lib/format';

const REASONS = [
  ['customer_service', 'Customer service'],
  ['promotion', 'Promotion'],
  ['price_match', 'Price match'],
  ['staff_meal', 'Staff meal'],
  ['complimentary', 'Complimentary'],
  ['other', 'Other'],
] as const;

/** "12.5" -> 1250 basis points, exactly; null when invalid or out of range. */
function percentToBasisPoints(text: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bp >= 1 && bp <= 10_000 ? bp : null;
}

interface Props {
  restaurantId: string;
  token: string;
  /** Places the ticket if needed and returns the order to discount. */
  ensureOrder: () => Promise<OrderView>;
  onApplied: (order: OrderView) => void;
  onClose: () => void;
}

/**
 * Discount entry with inline manager override. If the API answers
 * OVERRIDE_REQUIRED, an approver re-authenticates on this terminal; the
 * resulting single-use override is sent with a retry of the same discount.
 * Approver credentials are sent once and never stored.
 */
export function DiscountPanel({ restaurantId, token, ensureOrder, onApplied, onClose }: Props) {
  const [kind, setKind] = useState<'percent' | 'amount'>('percent');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState<(typeof REASONS)[number][0]>('customer_service');
  const [needsOverride, setNeedsOverride] = useState<{
    orderId: string;
    discountCents: number;
  } | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = kind === 'percent' ? percentToBasisPoints(value) : dollarsToCents(value);
  const valid = parsed !== null && parsed > 0;

  // Synchronous guard against double taps (state updates land a render later).
  const inFlight = useRef(false);
  // One key per discount attempt, kept across network failures so a retry
  // replays the original result; rotated only after a definitive 4xx.
  const attemptKey = useRef(newIdempotencyKey());

  const send = async (orderId: string, overrideToken?: string) => {
    try {
      const res = await api<OrderView>(
        `/v1/restaurants/${restaurantId}/orders/${orderId}/discount`,
        {
          method: 'POST',
          token,
          idempotencyKey: attemptKey.current,
          body: { kind, value: parsed, reason, ...(overrideToken ? { overrideToken } : {}) },
        },
      );
      onApplied(res.data);
    } catch (err) {
      const definitive = err instanceof ApiError && err.status >= 400 && err.status < 500;
      if (!definitive)
        throw new Error('Connection problem. Tap again — the discount will not be applied twice.', {
          cause: err,
        });
      attemptKey.current = newIdempotencyKey();
      if (err.code === 'DISCOUNT_ALREADY_APPLIED' || err.code === 'ORDER_NOT_AWAITING_PAYMENT') {
        // An earlier attempt probably succeeded but its response was lost: show the real order.
        onApplied(
          (await api<OrderView>(`/v1/restaurants/${restaurantId}/orders/${orderId}`, { token }))
            .data,
        );
        return;
      }
      throw err;
    }
  };

  const run = async (work: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const apply = () =>
    run(async () => {
      if (!valid) return;
      const order = await ensureOrder();
      try {
        await send(order.id);
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'OVERRIDE_REQUIRED')) throw err;
        setNeedsOverride({
          orderId: order.id,
          discountCents: Number(err.details?.discountCents ?? 0),
        });
      }
    });

  const approve = () =>
    run(async () => {
      if (!needsOverride) return;
      try {
        // The approver authorises this exact discount; the server binds the override to it.
        const granted = await api<OverrideResponse>(`/v1/restaurants/${restaurantId}/overrides`, {
          method: 'POST',
          token,
          body: {
            email,
            password,
            action: 'order.discount',
            orderId: needsOverride.orderId,
            discount: { kind, value: parsed, reason },
          },
        });
        await send(needsOverride.orderId, granted.data.overrideToken);
      } finally {
        // Approver credentials never outlive the attempt.
        setPassword('');
        setEmail('');
      }
    });

  if (needsOverride) {
    return (
      <form
        className="space-y-2 rounded-xl border border-warn/30 bg-warn-soft p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void approve();
        }}
        aria-label="Manager approval"
      >
        <p className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="size-4" aria-hidden /> Manager approval for{' '}
          {money(needsOverride.discountCents)} off
        </p>
        <input
          type="email"
          required
          autoComplete="off"
          placeholder="Manager email"
          aria-label="Manager email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-11 w-full rounded-lg border border-line bg-paper px-3 text-sm"
        />
        <input
          type="password"
          required
          autoComplete="off"
          placeholder="Manager password"
          aria-label="Manager password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="h-11 w-full rounded-lg border border-line bg-paper px-3 text-sm"
        />
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="grid grid-cols-[auto_1fr] gap-2">
          <Button type="button" variant="secondary" size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="lg" loading={busy}>
            Approve discount
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        void apply();
      }}
      aria-label="Discount"
    >
      <div className="grid grid-cols-2 gap-2">
        {(['percent', 'amount'] as const).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
            className={clsx(
              'h-11 rounded-lg border text-sm font-semibold',
              kind === k ? 'border-brand bg-brand-soft' : 'border-line',
            )}
          >
            {k === 'percent' ? 'Percent %' : 'Amount $'}
          </button>
        ))}
      </div>
      <input
        inputMode="decimal"
        autoFocus
        placeholder={kind === 'percent' ? 'e.g. 10' : 'e.g. 2.50'}
        aria-label={kind === 'percent' ? 'Discount percent' : 'Discount amount'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-12 w-full rounded-lg border border-line px-3 text-lg font-semibold"
      />
      <select
        aria-label="Discount reason"
        value={reason}
        onChange={(e) => setReason(e.target.value as typeof reason)}
        className="h-11 w-full rounded-lg border border-line bg-paper px-3 text-sm"
      >
        {REASONS.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="grid grid-cols-[auto_1fr] gap-2">
        <Button type="button" variant="secondary" size="lg" onClick={onClose}>
          Back
        </Button>
        <Button type="submit" size="lg" loading={busy} disabled={!valid}>
          Apply discount
        </Button>
      </div>
    </form>
  );
}
