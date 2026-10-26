'use client';

import type { KitchenTaskView, StationView } from '@kitchos/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowLeft, CheckCircle2, Flame, Info, Play, Wifi, WifiOff } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { StaffGate } from '@/components/staff-gate';
import { Button, EmptyState, Logo, Spinner } from '@/components/ui';
import { api, ApiError, get } from '@/lib/api';
import { elapsed, elapsedSeconds, FULFILMENT_LABEL } from '@/lib/format';
import { useLiveEvents } from '@/lib/live';
import type { StaffSession } from '@/lib/session';

// Display thresholds for ticket ageing (seconds). Configurable per restaurant later.
const WARN_AFTER = 5 * 60;
const LATE_AFTER = 8 * 60;

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export default function KitchenPage() {
  return (
    <StaffGate>
      {(session) => (
        <Suspense fallback={<Spinner />}>
          <KitchenDisplay session={session} />
        </Suspense>
      )}
    </StaffGate>
  );
}

function KitchenDisplay({ session }: { session: StaffSession }) {
  const { restaurantId } = useParams<{ restaurantId: string }>();
  const station = useSearchParams().get('station');
  const router = useRouter();
  const qc = useQueryClient();
  const token = session.accessToken;
  const now = useNow();
  const restaurant = session.me.restaurants.find((r) => r.id === restaurantId);
  const canOperate = restaurant?.permissions.includes('kitchen.operate') ?? false;

  const stations = useQuery({
    queryKey: ['stations', restaurantId],
    queryFn: ({ signal }) =>
      get<StationView[]>(`/v1/restaurants/${restaurantId}/kitchen/stations`, token, signal),
  });
  const tasksKey = ['tasks', restaurantId, station ?? 'all'];
  const tasks = useQuery({
    queryKey: tasksKey,
    queryFn: ({ signal }) =>
      get<KitchenTaskView[]>(
        `/v1/restaurants/${restaurantId}/kitchen/tasks${station ? `?station=${station}` : ''}`,
        token,
        signal,
      ),
    refetchInterval: 10_000, // fallback if the live stream drops
  });
  const live = useLiveEvents(
    restaurantId,
    token,
    () => void qc.invalidateQueries({ queryKey: ['tasks', restaurantId] }),
  );

  const [notice, setNotice] = useState<string | null>(null);
  const command = useMutation({
    mutationFn: ({ task, action }: { task: KitchenTaskView; action: 'start' | 'complete' }) =>
      api<KitchenTaskView>(`/v1/restaurants/${restaurantId}/kitchen/tasks/${task.id}/${action}`, {
        method: 'POST',
        token,
        body: { expectedVersion: task.version },
      }),
    onSuccess: () => setNotice(null),
    onError: (err) => {
      if (err instanceof ApiError && err.status === 401) router.replace('/staff');
      setNotice(
        err instanceof ApiError && err.code === 'CONCURRENT_MODIFICATION'
          ? 'That ticket was just updated on another screen — refreshed.'
          : err.message,
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['tasks', restaurantId] }),
  });

  const byOrder = useMemo(() => {
    const groups = new Map<string, KitchenTaskView[]>();
    for (const t of tasks.data ?? []) groups.set(t.orderId, [...(groups.get(t.orderId) ?? []), t]);
    return [...groups.values()].sort((a, b) => a[0]!.queuedAt.localeCompare(b[0]!.queuedAt));
  }, [tasks.data]);

  const stationName = station
    ? (stations.data?.find((s) => s.code === station)?.name ?? station)
    : 'All stations';

  return (
    <div className="theme-ops flex min-h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-ops-line px-4 py-3">
        <Link
          href="/staff"
          className="rounded-md p-2 text-ops-muted hover:bg-ops-raised"
          aria-label="Back to workspaces"
        >
          <ArrowLeft className="size-5" />
        </Link>
        <Logo inverted />
        <div className="mr-auto">
          <h1 className="text-lg font-bold leading-tight">{stationName}</h1>
          <p className="text-xs text-ops-muted">{restaurant?.name}</p>
        </div>
        <span
          className={clsx(
            'inline-flex items-center gap-1.5 text-xs',
            live === 'live' ? 'text-emerald-400' : 'text-amber-400',
          )}
          role="status"
        >
          {live === 'live' ? (
            <Wifi className="size-4" aria-hidden />
          ) : (
            <WifiOff className="size-4" aria-hidden />
          )}
          {live === 'live' ? 'Live' : live === 'offline' ? 'Polling' : 'Reconnecting'}
        </span>
        <span className="text-sm tabular-nums text-ops-muted">
          {(tasks.data ?? []).length} active
        </span>
      </header>

      <nav
        aria-label="Stations"
        className="flex gap-2 overflow-x-auto border-b border-ops-line px-4 py-2"
      >
        {[{ code: null, name: 'All' }, ...(stations.data ?? [])].map((s) => (
          <Link
            key={s.code ?? 'all'}
            href={s.code ? `?station=${s.code}` : '?'}
            aria-current={station === s.code ? 'page' : undefined}
            className={clsx(
              'h-10 shrink-0 rounded-lg px-4 text-sm font-semibold leading-10',
              station === s.code
                ? 'bg-ops-text text-ops-bg'
                : 'bg-ops-raised text-ops-text hover:bg-ops-line',
            )}
          >
            {s.name}
          </Link>
        ))}
      </nav>

      {notice && (
        <div
          role="alert"
          className="mx-4 mt-3 flex items-center gap-2 rounded-lg bg-amber-500/15 px-3 py-2 text-sm text-amber-300"
        >
          <Info className="size-4" aria-hidden /> {notice}
        </div>
      )}
      {!canOperate && (
        <p className="mx-4 mt-3 text-sm text-ops-muted">
          View only — your role cannot update tickets here.
        </p>
      )}

      <main className="flex-1 p-4">
        {tasks.isPending ? (
          <Spinner label="Loading tickets" />
        ) : tasks.isError ? (
          <EmptyState title="Cannot load tickets" hint={tasks.error.message} />
        ) : byOrder.length === 0 ? (
          <EmptyState
            title="All caught up"
            hint="New tickets appear here automatically."
            className="text-ops-muted"
          />
        ) : (
          <ul className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(17rem,1fr))]">
            {byOrder.map((group) => {
              const first = group[0]!;
              const age = elapsedSeconds(first.queuedAt, now);
              return (
                <li
                  key={first.orderId}
                  className={clsx(
                    'flex flex-col overflow-hidden rounded-xl border-2 bg-ops-panel',
                    age >= LATE_AFTER
                      ? 'border-red-500'
                      : age >= WARN_AFTER
                        ? 'border-amber-400'
                        : 'border-ops-line',
                  )}
                >
                  <div
                    className={clsx(
                      'flex items-center justify-between px-4 py-2',
                      age >= LATE_AFTER
                        ? 'bg-red-500/20'
                        : age >= WARN_AFTER
                          ? 'bg-amber-400/15'
                          : 'bg-ops-raised',
                    )}
                  >
                    <span className="text-2xl font-black tabular-nums">#{first.orderNumber}</span>
                    <span className="text-right text-xs">
                      <span className="block font-semibold">
                        {FULFILMENT_LABEL[first.fulfilmentType]}
                      </span>
                      <span
                        className={clsx(
                          'tabular-nums',
                          age >= LATE_AFTER && 'font-bold text-red-300',
                        )}
                      >
                        {age >= LATE_AFTER && (
                          <Flame className="mr-0.5 inline size-3" aria-label="Late" />
                        )}
                        {elapsed(first.queuedAt, now)}
                      </span>
                    </span>
                  </div>
                  {first.customerName && (
                    <p className="px-4 pt-2 text-xs text-ops-muted">{first.customerName}</p>
                  )}
                  <ul className="flex-1 divide-y divide-ops-line">
                    {group.map((t) => (
                      <li key={t.id} className="space-y-2 px-4 py-3">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-lg font-bold leading-snug">
                            <span className="tabular-nums">{t.quantity}×</span> {t.label}
                          </p>
                          {!station && (
                            <span className="shrink-0 rounded bg-ops-raised px-1.5 py-0.5 text-[10px] uppercase text-ops-muted">
                              {t.stationCode}
                            </span>
                          )}
                        </div>
                        {t.modifiers.length > 0 && (
                          <ul className="flex flex-wrap gap-1">
                            {t.modifiers.map((m) => (
                              <li
                                key={m}
                                className="rounded bg-amber-400 px-2 py-0.5 text-xs font-bold text-black"
                              >
                                {m}
                              </li>
                            ))}
                          </ul>
                        )}
                        {t.instructions && (
                          <details className="text-xs text-ops-muted">
                            <summary className="cursor-pointer select-none">Recipe</summary>
                            <p className="mt-1">{t.instructions}</p>
                          </details>
                        )}
                        {canOperate && (
                          <div className="grid grid-cols-2 gap-2 pt-1">
                            <Button
                              variant="ops"
                              size="lg"
                              disabled={t.status !== 'queued'}
                              loading={
                                command.isPending &&
                                command.variables?.task.id === t.id &&
                                command.variables.action === 'start'
                              }
                              onClick={() => command.mutate({ task: t, action: 'start' })}
                            >
                              <Play className="size-4" aria-hidden />{' '}
                              {t.status === 'in_progress' ? 'Cooking' : 'Start'}
                            </Button>
                            <Button
                              variant="ops-primary"
                              size="lg"
                              loading={
                                command.isPending &&
                                command.variables?.task.id === t.id &&
                                command.variables.action === 'complete'
                              }
                              onClick={() => command.mutate({ task: t, action: 'complete' })}
                            >
                              <CheckCircle2 className="size-4" aria-hidden /> Done
                            </Button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
