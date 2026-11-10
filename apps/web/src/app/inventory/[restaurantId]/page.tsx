'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  GoodsReceiptForm,
  StockCountForm,
  StockLevels,
} from '@/components/inventory/stock-operations';
import { WasteEntry } from '@/components/inventory/waste-entry';
import { WasteReview } from '@/components/inventory/waste-review';
import { StaffGate } from '@/components/staff-gate';
import { Button, EmptyState, Logo } from '@/components/ui';
import type { StaffSession } from '@/lib/session';

export default function InventoryPage() {
  return <StaffGate>{(session) => <Inventory session={session} />}</StaffGate>;
}

type Tab = 'record' | 'review' | 'stock' | 'receive' | 'count';

function Inventory({ session }: { session: StaffSession }) {
  const { restaurantId } = useParams<{ restaurantId: string }>();
  const token = session.accessToken;
  const restaurant = session.me.restaurants.find((r) => r.id === restaurantId);
  const permissions = restaurant?.permissions ?? [];
  const has = (p: string) => permissions.includes(p);

  // Convenience only: the API enforces every one of these permissions.
  const tabs: [Tab, string][] = [
    ...(has('waste.record') ? ([['record', 'Record waste']] as [Tab, string][]) : []),
    ...(has('inventory.view') ? ([['review', 'Waste log']] as [Tab, string][]) : []),
    ...(has('inventory.view') ? ([['stock', 'Stock levels']] as [Tab, string][]) : []),
    ...(has('inventory.adjust') && has('inventory.view')
      ? ([
          ['receive', 'Receive goods'],
          ['count', 'Stock count'],
        ] as [Tab, string][])
      : []),
  ];
  const [chosen, setChosen] = useState<Tab | null>(null);
  const tab = tabs.some(([t]) => t === chosen) ? chosen : (tabs[0]?.[0] ?? null);

  return (
    <div className="min-h-dvh">
      <header className="flex items-center gap-3 border-b border-line bg-paper px-4 py-3">
        <Link
          href="/staff"
          className="rounded-md p-2 text-ink-muted hover:bg-canvas"
          aria-label="Back to workspaces"
        >
          <ArrowLeft className="size-5" />
        </Link>
        <Logo />
        <div>
          <h1 className="font-bold leading-tight">Inventory &amp; waste</h1>
          <p className="text-xs text-ink-muted">{restaurant?.name}</p>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-4 p-4">
        {!restaurant || tab === null ? (
          <EmptyState title="You do not have inventory access here" />
        ) : (
          <>
            <nav aria-label="Inventory sections" className="flex flex-wrap gap-2">
              {tabs.map(([t, label]) => (
                <Button
                  key={t}
                  size="sm"
                  variant={tab === t ? 'primary' : 'secondary'}
                  aria-current={tab === t ? 'page' : undefined}
                  onClick={() => setChosen(t)}
                >
                  {label}
                </Button>
              ))}
            </nav>
            {tab === 'record' && (
              <WasteEntry
                restaurantId={restaurantId}
                slug={restaurant.slug}
                token={token}
                permissions={permissions}
              />
            )}
            {tab === 'review' && (
              <WasteReview
                restaurantId={restaurantId}
                token={token}
                userId={session.me.user.id}
                canReview={has('waste.approve')}
                canSeeSummary={has('reports.view')}
              />
            )}
            {tab === 'stock' && <StockLevels restaurantId={restaurantId} token={token} />}
            {tab === 'receive' && <GoodsReceiptForm restaurantId={restaurantId} token={token} />}
            {tab === 'count' && <StockCountForm restaurantId={restaurantId} token={token} />}
          </>
        )}
      </main>
    </div>
  );
}
