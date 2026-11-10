'use client';

import type { DrawerAdminView } from '@kitchos/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, Spinner } from '@/components/ui';
import { api, get } from '@/lib/api';

/** Add and retire a restaurant's drawers. Retired drawers keep their history. */
export function DrawerAdmin({ restaurantId, token }: { restaurantId: string; token: string }) {
  const qc = useQueryClient();
  const base = `/v1/restaurants/${restaurantId}/cash/drawers`;
  const key = ['drawers-admin', restaurantId];
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const drawers = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => get<DrawerAdminView[]>(`${base}/all`, token, signal),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['drawers', restaurantId] });
  };
  const create = useMutation({
    mutationFn: () =>
      api(base, { method: 'POST', token, body: { code: code.trim(), name: name.trim() } }),
    onSuccess: () => {
      setName('');
      setCode('');
      refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: (d: DrawerAdminView) =>
      api(`${base}/${d.id}/${d.active ? 'retire' : 'reactivate'}`, { method: 'POST', token }),
    onSettled: refresh,
  });
  const valid = /^[a-z0-9-]{2,32}$/.test(code.trim()) && name.trim().length >= 2;

  return (
    <section aria-label="Manage drawers">
      <Card className="p-4">
        <h2 className="font-bold">Manage drawers</h2>
        {drawers.isPending ? (
          <Spinner label="Loading drawers" />
        ) : drawers.isError ? (
          <p role="alert" className="mt-2 text-sm text-danger">
            {drawers.error.message}
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-line text-sm">
            {drawers.data.map((d) => (
              <li
                key={d.id}
                data-testid="admin-drawer"
                className="flex items-center justify-between gap-2 py-2"
              >
                <span>
                  {d.name} <span className="text-ink-subtle">({d.code})</span>{' '}
                  {!d.active && <Badge>Retired</Badge>}
                  {d.inUse && <Badge tone="info">In use</Badge>}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={d.inUse || toggle.isPending}
                  onClick={() => toggle.mutate(d)}
                >
                  {d.active ? 'Retire' : 'Reactivate'}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {toggle.isError && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {toggle.error.message}
          </p>
        )}
        <form
          aria-label="Add a drawer"
          className="mt-3 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !create.isPending) create.mutate();
          }}
        >
          <input
            aria-label="Drawer name"
            placeholder="Name, e.g. Till 5"
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-10 min-w-0 flex-1 rounded-lg border border-line px-3 text-sm"
          />
          <input
            aria-label="Drawer code"
            placeholder="Code, e.g. till-5"
            maxLength={32}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="h-10 min-w-0 flex-1 rounded-lg border border-line px-3 text-sm"
          />
          <Button type="submit" variant="secondary" loading={create.isPending} disabled={!valid}>
            Add drawer
          </Button>
          {create.isError && (
            <p role="alert" className="w-full text-sm text-danger">
              {create.error.message}
            </p>
          )}
        </form>
      </Card>
    </section>
  );
}
