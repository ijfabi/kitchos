'use client';

import type { LoginResponse, MeResponse } from '@kitchos/contracts';
import { useCallback, useSyncExternalStore } from 'react';

/**
 * Staff session held in sessionStorage (scoped to one browser tab, cleared on
 * close). Shared kitchen screens should use device identity instead once it
 * exists (ADR-0009). Tokens are never written to localStorage.
 */
const KEY = 'kitchos.staff-session';

export interface StaffSession {
  accessToken: string;
  expiresAt: string;
  me: MeResponse;
}

const listeners = new Set<() => void>();
let cached: { raw: string | null; value: StaffSession | null } = { raw: null, value: null };

function read(): StaffSession | null {
  if (typeof window === 'undefined') return null;
  const raw = window.sessionStorage.getItem(KEY);
  if (raw === cached.raw) return cached.value;
  let value: StaffSession | null;
  try {
    const parsed = raw ? (JSON.parse(raw) as StaffSession) : null;
    value = parsed && new Date(parsed.expiresAt).getTime() > Date.now() ? parsed : null;
  } catch {
    value = null;
  }
  cached = { raw, value };
  return value;
}

function emit() {
  listeners.forEach((l) => l());
}

export function saveSession(login: LoginResponse): void {
  window.sessionStorage.setItem(KEY, JSON.stringify(login));
  emit();
}

export function clearSession(): void {
  window.sessionStorage.removeItem(KEY);
  emit();
}

export function useSession(): {
  session: StaffSession | null;
  ready: boolean;
  signOut: () => void;
} {
  const session = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    () => null,
  );
  const ready = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
  const signOut = useCallback(() => clearSession(), []);
  return { session, ready, signOut };
}
