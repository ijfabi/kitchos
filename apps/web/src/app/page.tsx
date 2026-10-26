'use client';

import type { PublicRestaurant } from '@kitchos/contracts';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ChefHat, MapPin, MonitorPlay } from 'lucide-react';
import Link from 'next/link';
import { Card, ErrorState, Logo, Spinner } from '@/components/ui';
import { get } from '@/lib/api';

export default function Home() {
  const restaurants = useQuery({
    queryKey: ['restaurants'],
    queryFn: ({ signal }) => get<PublicRestaurant[]>('/v1/public/restaurants', null, signal),
  });

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <header className="flex items-center justify-between">
        <Logo />
        <Link
          href="/staff"
          className="inline-flex items-center gap-2 rounded-lg border border-line bg-paper px-4 py-2 text-sm font-semibold hover:bg-canvas"
        >
          <ChefHat className="size-4" aria-hidden /> Staff sign in
        </Link>
      </header>

      <section className="py-12">
        <p className="text-sm font-semibold uppercase tracking-wider text-brand">
          Order. Operate. Optimise.
        </p>
        <h1 className="mt-2 max-w-2xl text-4xl font-black tracking-tight sm:text-5xl">
          Order ahead from a KitchOS restaurant
        </h1>
        <p className="mt-3 max-w-xl text-ink-muted">
          Choose a restaurant, customise your meal and follow it from the kitchen to the pickup
          counter in real time.
        </p>
      </section>

      <section aria-labelledby="restaurants-heading">
        <h2 id="restaurants-heading" className="mb-3 text-lg font-bold">
          Restaurants
        </h2>
        {restaurants.isPending && <Spinner label="Loading restaurants" />}
        {restaurants.isError && (
          <ErrorState
            message={restaurants.error.message}
            onRetry={() => void restaurants.refetch()}
          />
        )}
        {restaurants.data && (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {restaurants.data.map((r) => (
              <li key={r.slug}>
                <Card className="flex h-full flex-col p-5">
                  <h3 className="text-lg font-bold">{r.name}</h3>
                  <p className="mt-1 flex items-start gap-1 text-sm text-ink-muted">
                    <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden />
                    {r.address ?? 'Address not listed'}
                  </p>
                  <div className="mt-4 flex flex-1 items-end gap-2">
                    <Link
                      href={`/order/${r.slug}`}
                      className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-strong"
                    >
                      Start order <ArrowRight className="size-4" aria-hidden />
                    </Link>
                    <Link
                      href={`/pickup/${r.slug}`}
                      className="inline-flex h-10 items-center justify-center rounded-lg border border-line px-3 text-sm hover:bg-canvas"
                      aria-label={`${r.name} pickup board`}
                    >
                      <MonitorPlay className="size-4" aria-hidden />
                    </Link>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="mt-16 border-t border-line pt-6 text-xs text-ink-subtle">
        KitchOS demo environment · synthetic data · sandbox payments only.
      </footer>
    </div>
  );
}
