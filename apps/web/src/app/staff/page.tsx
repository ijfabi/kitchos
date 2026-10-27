'use client';

import type { LoginResponse } from '@kitchos/contracts';
import { useMutation } from '@tanstack/react-query';
import { BookOpen, ChefHat, ClipboardCheck, LogOut, ShoppingCart, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Logo, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { saveSession, useSession } from '@/lib/session';

export default function StaffHome() {
  const { session, ready, signOut } = useSession();
  if (!ready) return <Spinner />;
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <header className="flex items-center justify-between">
        <Link href="/" aria-label="KitchOS home">
          <Logo />
        </Link>
        {session && (
          <Button variant="ghost" size="sm" onClick={signOut}>
            <LogOut className="size-4" aria-hidden /> Sign out
          </Button>
        )}
      </header>
      {session ? <Workspaces /> : <LoginForm />}
    </div>
  );
}

function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () =>
      api<LoginResponse>('/v1/auth/login', { method: 'POST', body: { email, password } }),
    onSuccess: (res) => saveSession(res.data),
  });
  return (
    <Card className="mx-auto mt-12 max-w-sm p-6">
      <h1 className="text-xl font-bold">Staff sign in</h1>
      <p className="mt-1 text-sm text-ink-muted">Use your KitchOS staff account.</p>
      <form
        className="mt-5 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate();
        }}
      >
        <label className="block text-sm">
          <span className="font-medium">Email</span>
          <input
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 h-11 w-full rounded-lg border border-line px-3"
          />
        </label>
        <label className="block text-sm">
          <span className="font-medium">Password</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 h-11 w-full rounded-lg border border-line px-3"
          />
        </label>
        {login.isError && (
          <p role="alert" className="rounded-lg bg-danger-soft p-3 text-sm text-danger">
            {login.error.message}
          </p>
        )}
        <Button type="submit" size="lg" className="w-full" loading={login.isPending}>
          Sign in
        </Button>
      </form>
      <p className="mt-4 text-xs text-ink-subtle">
        Demo: <code>crew1@central.kitchos.test</code> or <code>manager@central.kitchos.test</code>,
        password <code>kitchos-demo-pass</code>.
      </p>
    </Card>
  );
}

function Workspaces() {
  const { session } = useSession();
  if (!session) return null;
  const { me } = session;
  return (
    <section className="mt-8">
      <h1 className="text-2xl font-bold">Hi {me.user.displayName.split(' ')[0]}</h1>
      <p className="text-ink-muted">Choose where you are working.</p>
      {me.restaurants.length === 0 && (
        <p className="mt-6 text-ink-muted">You do not have access to any restaurant yet.</p>
      )}
      <ul className="mt-6 space-y-4">
        {me.restaurants.map((r) => (
          <li key={r.id}>
            <Card className="p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-bold">{r.name}</h2>
                <div className="flex flex-wrap gap-1">
                  {me.roles
                    .filter((a) => a.scopeId === r.id || a.scopeType !== 'restaurant')
                    .map((a) => (
                      <Badge key={`${a.role}-${a.scopeId}`}>{a.role.replace(/_/g, ' ')}</Badge>
                    ))}
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {r.permissions.includes('orders.create') && (
                  <Link
                    href={`/pos/${r.id}`}
                    className="inline-flex h-11 items-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-strong"
                  >
                    <ShoppingCart className="size-4" aria-hidden /> Point of sale
                  </Link>
                )}
                {r.permissions.includes('kitchen.view') && (
                  <Link
                    href={`/kitchen/${r.id}`}
                    className="inline-flex h-11 items-center gap-2 rounded-lg bg-ink px-4 text-sm font-semibold text-white hover:bg-ink/90"
                  >
                    <ChefHat className="size-4" aria-hidden /> Kitchen display
                  </Link>
                )}
                {r.permissions.includes('orders.view') && (
                  <Link
                    href={`/expo/${r.id}`}
                    className="inline-flex h-11 items-center gap-2 rounded-lg border border-line px-4 text-sm font-semibold hover:bg-canvas"
                  >
                    <ClipboardCheck className="size-4" aria-hidden /> Expo & handoff
                  </Link>
                )}
                {r.permissions.includes('payments.refund') && (
                  <Link
                    href={`/orders/${r.id}`}
                    className="inline-flex h-11 items-center gap-2 rounded-lg border border-line px-4 text-sm font-semibold hover:bg-canvas"
                  >
                    <Undo2 className="size-4" aria-hidden /> Orders &amp; refunds
                  </Link>
                )}
                {r.permissions.includes('reports.view') && (
                  <Link
                    href={`/accounting/${r.id}`}
                    className="inline-flex h-11 items-center gap-2 rounded-lg border border-line px-4 text-sm font-semibold hover:bg-canvas"
                  >
                    <BookOpen className="size-4" aria-hidden /> Books
                  </Link>
                )}
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}
