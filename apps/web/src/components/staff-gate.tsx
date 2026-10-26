'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { Spinner } from '@/components/ui';
import { useSession, type StaffSession } from '@/lib/session';

/** Renders children only for a signed-in staff member; otherwise sends them to sign in. */
export function StaffGate({ children }: { children: (session: StaffSession) => ReactNode }) {
  const { session, ready } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (ready && !session) router.replace('/staff');
  }, [ready, session, router]);
  if (!ready || !session) return <Spinner label="Checking sign-in" />;
  return <>{children(session)}</>;
}
