'use client';

import type { MenuItemView, MenuResponse, OrderView } from '@kitchos/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  ArrowLeft,
  Banknote,
  Ban,
  CreditCard,
  PauseCircle,
  Percent,
  RotateCcw,
  Trash2,
  Wallet,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { ItemDialog, type CartLine } from '@/components/order/item-dialog';
import { DiscountPanel } from '@/components/pos/discount-panel';
import { DrawerPanel, useMyDrawer } from '@/components/pos/drawer-panel';
import { StaffGate } from '@/components/staff-gate';
import { Badge, Button, EmptyState, Logo, Spinner } from '@/components/ui';
import { api, ApiError, get, newIdempotencyKey } from '@/lib/api';
import { dollarsToCents, money } from '@/lib/format';
import type { StaffSession } from '@/lib/session';
import { cashPayableCents } from '@kitchos/domain';

/** Integer cents -> "12.50" for the tender input, using string arithmetic only. */
function centsToInput(v: number): string {
  const s = String(v).padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

export default function PosPage() {
  return <StaffGate>{(session) => <Pos session={session} />}</StaffGate>;
}

type Tender = { method: 'cash'; tenderedCents: number } | { method: 'card'; paymentToken: string };

/** Quick cash amounts: exact, then the next round notes above the amount due. */
function quickTenders(due: number): number[] {
  const out = new Set<number>([due]);
  for (const step of [500, 1000, 2000, 5000, 10000]) out.add(Math.ceil(due / step) * step);
  return [...out]
    .filter((v) => v >= due)
    .sort((a, b) => a - b)
    .slice(0, 5);
}

function Pos({ session }: { session: StaffSession }) {
  const { restaurantId } = useParams<{ restaurantId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const token = session.accessToken;
  const restaurant = session.me.restaurants.find((r) => r.id === restaurantId);
  const canVoid = restaurant?.permissions.includes('orders.cancel') ?? false;
  const canManageCash = restaurant?.permissions.includes('cash.manage') ?? false;
  // Cash goes through the cashier's own open drawer session.
  const { mine: myDrawer } = useMyDrawer(restaurantId, token, session.me.user.id);
  const drawerOpen = myDrawer?.activeSession?.status === 'open';
  const [drawerPanel, setDrawerPanel] = useState(false);

  const menu = useQuery({
    queryKey: ['menu', restaurant?.slug],
    enabled: !!restaurant,
    queryFn: ({ signal }) =>
      get<MenuResponse>(`/v1/public/restaurants/${restaurant!.slug}/menu`, null, signal),
  });
  const parked = useQuery({
    queryKey: ['parked', restaurantId],
    queryFn: ({ signal }) =>
      get<OrderView[]>(
        `/v1/restaurants/${restaurantId}/orders?status=pending_payment&channel=pos`,
        token,
        signal,
      ),
    refetchInterval: 15_000,
  });

  const [category, setCategory] = useState<string | null>(null);
  const [lines, setLines] = useState<CartLine[]>([]);
  const [selected, setSelected] = useState<MenuItemView | null>(null);
  const [name, setName] = useState('');
  const [fulfilment, setFulfilment] = useState<'dine_in' | 'takeaway'>('dine_in');
  /** A placed-but-unpaid order (parked, recalled, or created at tender time). */
  const [active, setActive] = useState<OrderView | null>(null);
  const [cashOpen, setCashOpen] = useState(false);
  const [tendered, setTendered] = useState('');
  const [done, setDone] = useState<OrderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [payableHint, setPayableHint] = useState<number | null>(null);
  const [discountOpen, setDiscountOpen] = useState(false);
  // One key per ticket so retries never create a second order; one per payment attempt.
  const ticketKey = useRef(newIdempotencyKey());

  const categories = useMemo(
    () => [...new Set(menu.data?.items.map((i) => i.category) ?? [])],
    [menu.data],
  );
  const visible = (menu.data?.items ?? []).filter((i) => !category || i.category === category);
  const estimate = lines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
  const due = active?.totalCents ?? estimate;
  // Server-authoritative once the order exists; before that, the same domain rule on the estimate.
  const cashDue =
    active?.cashDueCents ??
    cashPayableCents(estimate, menu.data?.restaurant.cashRoundingIncrementCents ?? 1);

  const reset = () => {
    setLines([]);
    setName('');
    setActive(null);
    setCashOpen(false);
    setTendered('');
    setError(null);
    setPayableHint(null);
    setDiscountOpen(false);
    ticketKey.current = newIdempotencyKey();
  };
  const onError = (err: Error) => {
    if (err instanceof ApiError && err.status === 401) router.replace('/staff');
    if (err instanceof ApiError && err.code === 'INSUFFICIENT_TENDER') {
      setPayableHint(Number(err.details?.payableCents));
      setError(`Cash due is ${money(Number(err.details?.payableCents))} after rounding.`);
    } else setError(err.message);
  };

  const placeTicket = async (): Promise<OrderView> => {
    if (active) return active;
    const res = await api<OrderView>(`/v1/restaurants/${restaurantId}/orders`, {
      method: 'POST',
      token,
      idempotencyKey: ticketKey.current,
      body: {
        channel: 'pos',
        fulfilmentType: fulfilment,
        customerName: name.trim() || undefined,
        lines: lines.map((l) => ({
          menuItemId: l.menuItemId,
          quantity: l.quantity,
          modifierOptionIds: l.modifierOptionIds,
          components: l.components,
        })),
      },
    });
    setActive(res.data);
    return res.data;
  };

  const park = useMutation({
    mutationFn: placeTicket,
    onSuccess: () => {
      reset();
      void qc.invalidateQueries({ queryKey: ['parked', restaurantId] });
    },
    onError,
  });

  const payKey = useRef(newIdempotencyKey());
  const pay = useMutation({
    mutationFn: async (tender: Tender) => {
      const order = await placeTicket();
      const res = await api<OrderView>(
        `/v1/restaurants/${restaurantId}/orders/${order.id}/payments`,
        {
          method: 'POST',
          token,
          idempotencyKey: payKey.current,
          body: tender,
          acceptStatuses: [402],
        },
      );
      return res;
    },
    onSuccess: (res) => {
      payKey.current = newIdempotencyKey();
      if (res.status === 402) {
        setActive(res.data);
        setError(
          `Card declined (${res.data.payment?.failureReason?.replace(/_/g, ' ')}). The order is still open.`,
        );
        return;
      }
      setDone(res.data);
      reset();
      void qc.invalidateQueries({ queryKey: ['parked', restaurantId] });
    },
    onError: async (err) => {
      const definitive = err instanceof ApiError && err.status >= 400 && err.status < 500;
      if (!definitive) {
        // Network drop or server error: the payment may have been taken. Keep the
        // same key so retrying replays the original result instead of paying again.
        setError('Connection problem. Tap the same payment again — it will not be taken twice.');
        return;
      }
      payKey.current = newIdempotencyKey();
      if (err.code === 'ORDER_NOT_AWAITING_PAYMENT' && active) {
        // Most likely an earlier attempt succeeded but its response was lost.
        const current = await get<OrderView>(
          `/v1/restaurants/${restaurantId}/orders/${active.id}`,
          token,
        ).catch(() => null);
        if (current?.payment?.status === 'captured') {
          setDone(current);
          reset();
          void qc.invalidateQueries({ queryKey: ['parked', restaurantId] });
          return;
        }
      }
      onError(err);
    },
  });

  const voidOrder = useMutation({
    mutationFn: (o: OrderView) =>
      api<OrderView>(`/v1/restaurants/${restaurantId}/orders/${o.id}/cancel`, {
        method: 'POST',
        token,
        body: { reason: 'Parked order voided at POS' },
      }),
    onSuccess: (_res, o) => {
      if (active?.id === o.id) reset();
      void qc.invalidateQueries({ queryKey: ['parked', restaurantId] });
    },
    onError,
  });

  if (!restaurant) return <EmptyState title="No access to this restaurant" />;
  if (menu.isPending) return <Spinner label="Loading menu" />;
  if (menu.isError) return <EmptyState title="Cannot load the menu" hint={menu.error.message} />;

  const tenderedCents = dollarsToCents(tendered);
  const tenderValid = tenderedCents !== null;
  const busy = pay.isPending || park.isPending;
  // The order on screen is unpaid too; don't list it as parked.
  const parkedOthers = (parked.data ?? []).filter((o) => o.id !== active?.id);
  const editable = !active;

  return (
    <div className="flex h-dvh flex-col bg-canvas">
      <header className="flex items-center gap-3 border-b border-line bg-paper px-4 py-2">
        <Link
          href="/staff"
          className="rounded-md p-2 text-ink-muted hover:bg-canvas"
          aria-label="Back to workspaces"
        >
          <ArrowLeft className="size-5" />
        </Link>
        <Logo />
        <div className="mr-auto">
          <h1 className="font-bold leading-tight">Point of sale</h1>
          <p className="text-xs text-ink-muted">
            {restaurant.name} · {session.me.user.displayName}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setDrawerPanel((v) => !v)}
          aria-expanded={drawerPanel}
          data-testid="drawer-button"
        >
          <Wallet className="size-4" aria-hidden />
          {drawerOpen ? myDrawer!.name : myDrawer ? 'Drawer awaiting approval' : 'No drawer open'}
        </Button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_24rem]">
        {/* Products */}
        <section aria-label="Products" className="flex min-h-0 flex-col">
          <nav
            aria-label="Categories"
            className="flex gap-2 overflow-x-auto border-b border-line bg-paper px-3 py-2"
          >
            {[null, ...categories].map((c) => (
              <button
                key={c ?? 'all'}
                onClick={() => setCategory(c)}
                aria-pressed={category === c}
                className={clsx(
                  'h-11 shrink-0 rounded-lg px-4 text-sm font-semibold',
                  category === c ? 'bg-ink text-white' : 'bg-canvas hover:bg-line',
                )}
              >
                {c ?? 'All'}
              </button>
            ))}
          </nav>
          <ul className="grid flex-1 auto-rows-[6.5rem] gap-2 overflow-y-auto p-3 [grid-template-columns:repeat(auto-fill,minmax(9.5rem,1fr))]">
            {visible.map((i) => (
              <li key={i.id}>
                <button
                  disabled={!i.available || !editable}
                  onClick={() =>
                    i.modifierGroups.length || i.components.some((c) => c.modifierGroups.length)
                      ? setSelected(i)
                      : setLines((ls) => [
                          ...ls,
                          {
                            key: crypto.randomUUID(),
                            menuItemId: i.id,
                            name: i.name,
                            quantity: 1,
                            modifierOptionIds: [],
                            components: [],
                            unitPriceCents: i.priceCents,
                            summary: [],
                          },
                        ])
                  }
                  className="flex size-full flex-col justify-between rounded-xl border border-line bg-paper p-3 text-left shadow-sm active:scale-[0.98] disabled:opacity-50"
                >
                  <span className="font-semibold leading-tight">{i.name}</span>
                  <span className="flex items-center justify-between text-sm">
                    <span className="font-semibold text-brand-strong">{money(i.priceCents)}</span>
                    {i.kind === 'combo' && <Badge tone="brand">Meal</Badge>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {/* Ticket */}
        <aside
          aria-label="Current order"
          className="flex min-h-0 flex-col border-l border-line bg-paper"
        >
          {done ? (
            <div
              className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
              role="status"
            >
              <p className="text-sm text-ink-muted">Order</p>
              <p className="text-6xl font-black">#{done.orderNumber}</p>
              <p className="text-ink-muted">
                {done.payment
                  ? `Paid ${done.payment.method === 'cash' ? 'cash' : `by ${done.payment.cardBrand}`} · ${money(done.totalCents)}`
                  : 'Complimentary · nothing to pay · sent to the kitchen'}
              </p>
              {done.payment?.method === 'cash' && (
                <div className="mt-2 rounded-xl bg-ok-soft px-8 py-4">
                  <p className="text-sm font-medium text-ok">Change due</p>
                  <p className="text-4xl font-black text-ok" data-testid="change-due">
                    {money(done.payment.changeCents ?? 0)}
                  </p>
                  {done.payment.cashRoundingCents !== 0 && (
                    <p className="text-xs text-ink-muted">
                      Cash rounding {money(done.payment.cashRoundingCents)}
                    </p>
                  )}
                </div>
              )}
              <Button size="xl" className="mt-4 w-full" onClick={() => setDone(null)}>
                New sale
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-line px-4 py-3">
                <h2 className="font-bold">
                  {active ? `Order #${active.orderNumber}` : 'New order'}
                </h2>
                {(lines.length > 0 || active) && (
                  <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>
                    <X className="size-4" aria-hidden /> Clear
                  </Button>
                )}
              </div>
              <ul className="flex-1 divide-y divide-line overflow-y-auto px-4">
                {active
                  ? active.lines.map((l) => (
                      <li key={l.id} className="flex justify-between gap-2 py-2 text-sm">
                        <span>
                          {l.quantity} × {l.name}
                        </span>
                        <span>{money(l.lineTotalCents)}</span>
                      </li>
                    ))
                  : lines.map((l) => (
                      <li
                        key={l.key}
                        className="flex items-start justify-between gap-2 py-2 text-sm"
                      >
                        <div>
                          <p className="font-medium">
                            {l.quantity} × {l.name}
                          </p>
                          {l.summary.length > 0 && (
                            <p className="text-xs text-ink-muted">{l.summary.join(', ')}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <span>{money(l.unitPriceCents * l.quantity)}</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Remove ${l.name}`}
                            onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </li>
                    ))}
                {active?.discount && (
                  <li
                    className="flex justify-between gap-2 py-2 text-sm text-ok"
                    data-testid="discount-line"
                  >
                    <span>
                      Discount · {active.discount.reason.replace(/_/g, ' ')}
                      {active.discount.viaOverride &&
                        ` (approved by ${active.discount.approvedBy})`}
                    </span>
                    <span className="shrink-0 whitespace-nowrap">
                      −{money(active.discount.amountCents)}
                    </span>
                  </li>
                )}
                {!active && lines.length === 0 && (
                  <EmptyState title="Tap products to start an order" />
                )}
              </ul>

              <div className="space-y-3 border-t border-line p-4">
                {editable && (
                  <div className="flex gap-2">
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Name / table"
                      aria-label="Customer name or table"
                      maxLength={60}
                      className="h-11 min-w-0 flex-1 rounded-lg border border-line px-3 text-sm"
                    />
                    {(['dine_in', 'takeaway'] as const).map((f) => (
                      <button
                        key={f}
                        onClick={() => setFulfilment(f)}
                        aria-pressed={fulfilment === f}
                        className={clsx(
                          'h-11 rounded-lg border px-3 text-sm font-semibold',
                          fulfilment === f ? 'border-brand bg-brand-soft' : 'border-line',
                        )}
                      >
                        {f === 'dine_in' ? 'Dine in' : 'Takeaway'}
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex items-baseline justify-between">
                  <span className="text-sm text-ink-muted">Total (incl. GST)</span>
                  <span className="text-3xl font-black" data-testid="pos-total">
                    {money(due)}
                  </span>
                </div>
                {error && (
                  <p
                    role="alert"
                    className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
                  >
                    {error}
                  </p>
                )}

                {drawerPanel ? (
                  <DrawerPanel
                    restaurantId={restaurantId}
                    token={token}
                    userId={session.me.user.id}
                    canManage={canManageCash}
                    onClose={() => setDrawerPanel(false)}
                  />
                ) : discountOpen ? (
                  <DiscountPanel
                    restaurantId={restaurantId}
                    token={token}
                    ensureOrder={placeTicket}
                    onClose={() => setDiscountOpen(false)}
                    onApplied={(order) => {
                      setDiscountOpen(false);
                      void qc.invalidateQueries({ queryKey: ['parked', restaurantId] });
                      if (order.status !== 'pending_payment') {
                        // Fully discounted: already sent to the kitchen, nothing to pay.
                        setDone(order);
                        reset();
                      } else setActive(order);
                    }}
                  />
                ) : cashOpen ? (
                  <form
                    className="space-y-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (tenderedCents !== null && !pay.isPending) {
                        pay.mutate({ method: 'cash', tenderedCents });
                      }
                    }}
                  >
                    <div className="flex items-baseline justify-between rounded-lg bg-canvas px-3 py-2">
                      <span className="text-sm font-medium">Cash due</span>
                      <span className="text-xl font-black" data-testid="cash-due">
                        {money(payableHint ?? cashDue)}
                      </span>
                    </div>
                    {(payableHint ?? cashDue) !== due && (
                      <p className="text-xs text-ink-subtle">
                        Cash is rounded to the nearest{' '}
                        {money(menu.data.restaurant.cashRoundingIncrementCents)}; card pays the
                        exact total.
                      </p>
                    )}
                    <div className="grid grid-cols-3 gap-2">
                      {quickTenders(payableHint ?? cashDue).map((v) => (
                        <Button
                          key={v}
                          type="button"
                          variant="secondary"
                          size="lg"
                          onClick={() => setTendered(centsToInput(v))}
                        >
                          {money(v)}
                        </Button>
                      ))}
                    </div>
                    <label className="block text-sm">
                      <span className="font-medium">Cash tendered</span>
                      <input
                        inputMode="decimal"
                        autoFocus
                        value={tendered}
                        onChange={(e) => setTendered(e.target.value)}
                        placeholder="0.00"
                        className="mt-1 h-12 w-full rounded-lg border border-line px-3 text-lg font-semibold"
                      />
                    </label>
                    <div className="grid grid-cols-[auto_1fr] gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        size="xl"
                        onClick={() => setCashOpen(false)}
                      >
                        Back
                      </Button>
                      <Button
                        type="submit"
                        size="xl"
                        loading={pay.isPending}
                        disabled={!tenderValid}
                      >
                        Take cash
                      </Button>
                    </div>
                  </form>
                ) : (
                  <div className="grid grid-cols-3 gap-2">
                    <Button
                      variant="ghost"
                      size="md"
                      className="col-span-3 border border-dashed border-line"
                      disabled={(!active && lines.length === 0) || busy || !!active?.discount}
                      onClick={() => {
                        setError(null);
                        setDiscountOpen(true);
                      }}
                    >
                      <Percent className="size-4" aria-hidden />{' '}
                      {active?.discount ? 'Discount applied' : 'Discount'}
                    </Button>
                    <Button
                      variant="secondary"
                      size="xl"
                      disabled={!editable || lines.length === 0 || busy}
                      loading={park.isPending}
                      onClick={() => park.mutate()}
                    >
                      <PauseCircle className="size-5" aria-hidden /> Park
                    </Button>
                    <Button
                      variant="secondary"
                      size="xl"
                      disabled={(!active && lines.length === 0) || busy}
                      loading={pay.isPending}
                      onClick={() =>
                        pay.mutate({ method: 'card', paymentToken: 'tok_sandbox_approve' })
                      }
                    >
                      <CreditCard className="size-5" aria-hidden /> Card
                    </Button>
                    <Button
                      size="xl"
                      disabled={(!active && lines.length === 0) || busy || !drawerOpen}
                      title={drawerOpen ? undefined : 'Open a cash drawer to take cash'}
                      onClick={() => setCashOpen(true)}
                    >
                      <Banknote className="size-5" aria-hidden /> Cash
                    </Button>
                    {!drawerOpen && (
                      <p className="col-span-3 text-center text-xs text-ink-muted">
                        Cash needs an open drawer.{' '}
                        <button
                          className="font-semibold text-brand-strong underline"
                          onClick={() => setDrawerPanel(true)}
                        >
                          Open one
                        </button>
                      </p>
                    )}
                  </div>
                )}
                <p className="text-center text-[11px] text-ink-subtle">
                  Card uses the sandbox terminal. Prices are confirmed by the server.
                </p>
              </div>

              <details className="border-t border-line">
                <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold">
                  Parked orders ({parkedOthers.length})
                </summary>
                <ul className="max-h-56 divide-y divide-line overflow-y-auto px-4 pb-3">
                  {parkedOthers.map((o) => (
                    <li key={o.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                      <span>
                        <span className="font-semibold">#{o.orderNumber}</span>{' '}
                        {o.customerName ?? ''} · {money(o.totalCents)}
                      </span>
                      <span className="flex gap-1">
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy || lines.length > 0 || !!active}
                          onClick={() => {
                            setActive(o);
                            setError(null);
                            setPayableHint(null);
                            setTendered('');
                            setCashOpen(false);
                            payKey.current = newIdempotencyKey();
                          }}
                        >
                          <RotateCcw className="size-4" aria-hidden /> Recall
                        </Button>
                        {canVoid && (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Void order ${o.orderNumber}`}
                            loading={voidOrder.isPending && voidOrder.variables?.id === o.id}
                            onClick={() => voidOrder.mutate(o)}
                          >
                            <Ban className="size-4" />
                          </Button>
                        )}
                      </span>
                    </li>
                  ))}
                  {parkedOthers.length === 0 && (
                    <li className="py-2 text-sm text-ink-muted">No parked orders.</li>
                  )}
                </ul>
              </details>
            </>
          )}
        </aside>
      </div>

      <ItemDialog
        item={selected}
        onClose={() => setSelected(null)}
        onAdd={(line) => setLines((ls) => [...ls, line])}
      />
    </div>
  );
}
