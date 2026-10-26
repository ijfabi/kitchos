'use client';

import type { LiveEvent } from '@kitchos/contracts';
import { useEffect, useRef, useState } from 'react';
import { API_URL } from './api';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

/**
 * Subscribes to the restaurant's SSE stream using fetch (so the bearer token
 * travels in a header, not the URL). Reconnects with capped backoff. Events
 * are only hints to refetch; callers should also poll as a fallback.
 */
export function useLiveEvents(
  restaurantId: string | undefined,
  token: string | undefined,
  onEvent: (e: LiveEvent) => void,
): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  });

  useEffect(() => {
    if (!restaurantId || !token) return;
    const controller = new AbortController();
    let attempt = 0;
    let stopped = false;

    const run = async () => {
      while (!stopped) {
        try {
          const res = await fetch(`${API_URL}/v1/restaurants/${restaurantId}/live`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
            signal: controller.signal,
            cache: 'no-store',
          });
          if (res.status === 401 || res.status === 403 || res.status === 404) {
            setStatus('offline');
            return;
          }
          if (!res.ok || !res.body) throw new Error(`stream status ${res.status}`);
          setStatus('live');
          attempt = 0;
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            let sep: number;
            while ((sep = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, sep);
              buffer = buffer.slice(sep + 2);
              const type = /^event: ?(.*)$/m.exec(frame)?.[1];
              const data = /^data: ?(.*)$/m.exec(frame)?.[1];
              if (type === 'event' && data) handler.current(JSON.parse(data) as LiveEvent);
            }
          }
          throw new Error('stream ended');
        } catch (err) {
          if (stopped || (err as Error).name === 'AbortError') return;
          setStatus('reconnecting');
          attempt += 1;
          await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 15_000)));
        }
      }
    };
    void run();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [restaurantId, token]);

  return status;
}
