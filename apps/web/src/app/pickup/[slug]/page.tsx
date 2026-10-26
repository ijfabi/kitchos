'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { Logo } from '@/components/ui';
import { get } from '@/lib/api';

/** Customer-facing collection screen. Shows order numbers only — no names or items. */
export default function PickupBoard() {
  const { slug } = useParams<{ slug: string }>();
  const board = useQuery({
    queryKey: ['pickup', slug],
    queryFn: ({ signal }) =>
      get<{ preparing: number[]; ready: number[] }>(
        `/v1/public/restaurants/${slug}/pickup-board`,
        null,
        signal,
      ),
    refetchInterval: 4_000,
  });

  return (
    <div className="theme-ops flex min-h-dvh flex-col">
      <header className="flex items-center justify-between border-b border-ops-line px-8 py-4">
        <Logo inverted />
        <span className="text-sm text-ops-muted">
          {board.isError ? 'Reconnecting…' : 'Updated live'}
        </span>
      </header>
      <main className="grid flex-1 grid-cols-2 divide-x divide-ops-line">
        <section aria-labelledby="preparing" className="p-8">
          <h1 id="preparing" className="text-3xl font-bold text-ops-muted">
            Preparing
          </h1>
          <ul className="mt-6 flex flex-wrap gap-4" aria-live="polite">
            {board.data?.preparing.map((n) => (
              <li
                key={n}
                className="min-w-28 rounded-xl bg-ops-raised px-6 py-4 text-center text-5xl font-black tabular-nums"
              >
                {n}
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="ready" className="bg-emerald-950/40 p-8">
          <h1 id="ready" className="text-3xl font-bold text-emerald-300">
            Ready to collect
          </h1>
          <ul className="mt-6 flex flex-wrap gap-4" aria-live="assertive">
            {board.data?.ready.map((n) => (
              <li
                key={n}
                className="min-w-28 rounded-xl bg-emerald-600 px-6 py-4 text-center text-5xl font-black tabular-nums text-white"
              >
                {n}
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
