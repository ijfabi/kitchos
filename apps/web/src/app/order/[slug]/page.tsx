'use client';

import type { MenuItemView, MenuResponse, OrderView } from '@kitchos/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Clock, MapPin, ShoppingBag, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ItemDialog, type CartLine } from '@/components/order/item-dialog';
import { Badge, Button, Card, EmptyState, ErrorState, Logo, Spinner } from '@/components/ui';
import { api, ApiError, get, newIdempotencyKey } from '@/lib/api';
import { money } from '@/lib/format';

const SANDBOX_CARDS = [
  { token: 'tok_sandbox_approve', label: 'Visa ending 4242', hint: 'Sandbox: approves' },
  { token: 'tok_sandbox_mastercard', label: 'Mastercard ending 4444', hint: 'Sandbox: approves' },
  { token: 'tok_sandbox_decline', label: 'Visa ending 0002', hint: 'Sandbox: declines' },
] as const;

const FULFILMENT = [
  { value: 'takeaway', label: 'Takeaway' },
  { value: 'dine_in', label: 'Dine in' },
  { value: 'pickup', label: 'Pickup' },
] as const;

function useCart(slug: string) {
  const storageKey = `kitchos.cart.${slug}`;
  const [lines, setLines] = useState<CartLine[]>([]);
  const loaded = useRef(false);
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(storageKey);
      if (raw) setLines(JSON.parse(raw) as CartLine[]);
    } catch {
      // ignore corrupt cart
    }
    loaded.current = true;
  }, [storageKey]);
  useEffect(() => {
    if (loaded.current) window.sessionStorage.setItem(storageKey, JSON.stringify(lines));
  }, [lines, storageKey]);
  return [lines, setLines] as const;
}

export default function OrderPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const menu = useQuery({
    queryKey: ['menu', slug],
    queryFn: ({ signal }) => get<MenuResponse>(`/v1/public/restaurants/${slug}/menu`, null, signal),
  });
  const [lines, setLines] = useCart(slug);
  const [selected, setSelected] = useState<MenuItemView | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [name, setName] = useState('');
  const [fulfilment, setFulfilment] = useState<(typeof FULFILMENT)[number]['value']>('takeaway');
  const [card, setCard] = useState<string>(SANDBOX_CARDS[0].token);
  // One idempotency key per distinct checkout attempt: retries of the same cart reuse it.
  const checkoutKey = useMemo(() => newIdempotencyKey(), [lines, name, fulfilment]); // eslint-disable-line react-hooks/exhaustive-deps

  const categories = useMemo(
    () => [...new Set(menu.data?.items.map((i) => i.category) ?? [])],
    [menu.data],
  );
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (menu.data?.items ?? []).filter(
      (i) =>
        (!category || i.category === category) &&
        (!q || i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)),
    );
  }, [menu.data, category, search]);
  const estimate = lines.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);

  const checkout = useMutation({
    mutationFn: async () => {
      const placed = await api<OrderView>(`/v1/public/restaurants/${slug}/orders`, {
        method: 'POST',
        idempotencyKey: checkoutKey,
        body: {
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
      const token = placed.data.publicToken!;
      await api<OrderView>(`/v1/public/orders/${token}/payments`, {
        method: 'POST',
        idempotencyKey: `${checkoutKey}-pay`,
        body: { method: 'card', paymentToken: card },
        acceptStatuses: [402],
      });
      return token;
    },
    onSuccess: (token) => {
      setLines([]);
      router.push(`/order/track/${token}`);
    },
  });

  if (menu.isPending) return <Spinner label="Loading menu" />;
  if (menu.isError)
    return (
      <div className="p-6">
        <ErrorState message={menu.error.message} onRetry={() => void menu.refetch()} />
      </div>
    );
  const { restaurant } = menu.data;

  const checkoutError = checkout.error instanceof ApiError ? checkout.error : null;

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b border-line bg-paper/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
          <Link href="/" aria-label="KitchOS home">
            <Logo />
          </Link>
          <div className="hidden text-right text-sm sm:block">
            <p className="font-semibold">{restaurant.name}</p>
            <p className="flex items-center justify-end gap-1 text-ink-muted">
              <MapPin className="size-3.5" aria-hidden />
              {restaurant.address}
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-6 px-4 py-6 lg:grid-cols-[1fr_24rem]">
        <section aria-labelledby="menu-heading" className="min-w-0">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h1 id="menu-heading" className="text-2xl font-bold">
              Menu
            </h1>
            <input
              type="search"
              placeholder="Search the menu"
              aria-label="Search the menu"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-10 w-full rounded-lg border border-line bg-paper px-3 text-sm sm:w-64"
            />
          </div>
          <nav aria-label="Menu categories" className="mb-5 flex gap-2 overflow-x-auto pb-1">
            {[null, ...categories].map((c) => (
              <button
                key={c ?? 'all'}
                onClick={() => setCategory(c)}
                aria-pressed={category === c}
                className={clsx(
                  'h-9 shrink-0 rounded-full border px-4 text-sm font-medium',
                  category === c
                    ? 'border-ink bg-ink text-white'
                    : 'border-line bg-paper hover:bg-canvas',
                )}
              >
                {c ?? 'All'}
              </button>
            ))}
          </nav>
          {visible.length === 0 ? (
            <EmptyState title="Nothing matches your search" hint="Try another word or category." />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {visible.map((i) => (
                <li key={i.id}>
                  <button
                    onClick={() => setSelected(i)}
                    disabled={!i.available}
                    className="group flex h-full w-full flex-col rounded-xl border border-line bg-paper p-4 text-left shadow-sm transition hover:border-brand/40 hover:shadow disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-semibold">{i.name}</span>
                      <span className="shrink-0 font-semibold text-brand-strong">
                        {money(i.priceCents)}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 flex-1 text-sm text-ink-muted">
                      {i.description}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-1">
                      {i.kind === 'combo' && <Badge tone="brand">Meal</Badge>}
                      {!i.available && <Badge tone="danger">Unavailable</Badge>}
                      {i.energyKj !== null && (
                        <Badge>{i.energyKj.toLocaleString('en-AU')} kJ</Badge>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-6 text-xs text-ink-subtle">
            Prices include GST. The average adult daily energy intake is 8,700 kJ. Allergen
            information is shown on each item.
          </p>
        </section>

        <aside aria-labelledby="cart-heading" className="lg:sticky lg:top-20 lg:self-start">
          <Card className="p-4">
            <h2 id="cart-heading" className="flex items-center gap-2 text-lg font-bold">
              <ShoppingBag className="size-5" aria-hidden /> Your order
            </h2>
            {lines.length === 0 ? (
              <EmptyState
                title="Your order is empty"
                hint="Choose something tasty from the menu."
              />
            ) : (
              <>
                <ul className="mt-3 divide-y divide-line">
                  {lines.map((l) => (
                    <li key={l.key} className="flex items-start justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="font-medium">
                          {l.quantity} × {l.name}
                        </p>
                        {l.summary.length > 0 && (
                          <p className="text-xs text-ink-muted">{l.summary.join(', ')}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-sm font-semibold">
                          {money(l.unitPriceCents * l.quantity)}
                        </span>
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
                </ul>
                <div className="mt-2 flex justify-between border-t border-line pt-3 font-semibold">
                  <span>Total (incl. GST)</span>
                  <span>{money(estimate)}</span>
                </div>

                <form
                  className="mt-4 space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    checkout.mutate();
                  }}
                >
                  <label className="block text-sm">
                    <span className="font-medium">Name for your order</span>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={60}
                      autoComplete="given-name"
                      className="mt-1 h-10 w-full rounded-lg border border-line px-3"
                    />
                  </label>
                  <fieldset>
                    <legend className="text-sm font-medium">How would you like it?</legend>
                    <div className="mt-1 grid grid-cols-3 gap-2">
                      {FULFILMENT.map((f) => (
                        <label
                          key={f.value}
                          className={clsx(
                            'flex h-10 cursor-pointer items-center justify-center rounded-lg border text-sm',
                            fulfilment === f.value
                              ? 'border-brand bg-brand-soft font-semibold'
                              : 'border-line',
                          )}
                        >
                          <input
                            type="radio"
                            name="fulfilment"
                            value={f.value}
                            checked={fulfilment === f.value}
                            onChange={() => setFulfilment(f.value)}
                            className="sr-only"
                          />
                          {f.label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset>
                    <legend className="text-sm font-medium">Payment (sandbox test cards)</legend>
                    <div className="mt-1 space-y-2">
                      {SANDBOX_CARDS.map((c) => (
                        <label
                          key={c.token}
                          className={clsx(
                            'flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2 text-sm',
                            card === c.token ? 'border-brand bg-brand-soft' : 'border-line',
                          )}
                        >
                          <span className="flex items-center gap-2">
                            <input
                              type="radio"
                              name="card"
                              checked={card === c.token}
                              onChange={() => setCard(c.token)}
                              className="accent-[var(--color-brand)]"
                            />
                            {c.label}
                          </span>
                          <span className="text-xs text-ink-subtle">{c.hint}</span>
                        </label>
                      ))}
                    </div>
                    <p className="mt-1 text-xs text-ink-subtle">
                      No real card details are collected. KitchOS only ever receives a payment
                      token.
                    </p>
                  </fieldset>
                  {checkoutError && (
                    <div role="alert" className="rounded-lg bg-danger-soft p-3 text-sm text-danger">
                      {checkoutError.message}
                      {checkoutError.code === 'INSUFFICIENT_STOCK' &&
                        ' — please remove or change the affected items.'}
                    </div>
                  )}
                  <Button type="submit" size="lg" className="w-full" loading={checkout.isPending}>
                    Pay and place order
                  </Button>
                </form>
              </>
            )}
          </Card>
          {restaurant.openingHours && (
            <p className="mt-3 flex items-center gap-1 text-xs text-ink-subtle">
              <Clock className="size-3.5" aria-hidden /> Times shown in{' '}
              {restaurant.timezone.replace('_', ' ')}
            </p>
          )}
        </aside>
      </main>

      <ItemDialog
        item={selected}
        onClose={() => setSelected(null)}
        onAdd={(line) => setLines((ls) => [...ls, line])}
      />
    </div>
  );
}
