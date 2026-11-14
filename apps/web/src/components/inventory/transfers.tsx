'use client';

import type {
  CancelTransferRequest,
  ReceiveTransferRequest,
  StockBalanceView,
  StockTransferRequest,
  StockTransferView,
  TransferDestination,
} from '@kitchos/contracts';
import { parseDecimalQty } from '@kitchos/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, EmptyState, Spinner } from '@/components/ui';
import { api, ApiError, get } from '@/lib/api';
import { OUTCOME_UNKNOWN_HINT, outcomeUnknown, useAttemptKey } from '@/lib/attempt-key';
import { isPositiveQuantity, isQuantity, money, trimQuantity } from '@/lib/format';
import { inputClass } from './fields';

interface Props {
  restaurantId: string;
  token: string;
}

/** Stock transfers to and from other restaurants (ADR-0019, ADR-0020). */
export function Transfers(props: Props) {
  const { restaurantId, token } = props;
  const incoming = useQuery({
    queryKey: ['transfers', restaurantId, 'incoming'],
    queryFn: ({ signal }) =>
      get<StockTransferView[]>(
        `/v1/restaurants/${restaurantId}/inventory/transfers?direction=incoming&limit=20`,
        token,
        signal,
      ),
  });
  const outgoing = useQuery({
    queryKey: ['transfers', restaurantId, 'outgoing'],
    queryFn: ({ signal }) =>
      get<StockTransferView[]>(
        `/v1/restaurants/${restaurantId}/inventory/transfers?direction=outgoing&limit=20`,
        token,
        signal,
      ),
  });
  // Everything still in transit, however old, so it can always be received or cancelled.
  const open = (direction: 'incoming' | 'outgoing') => ({
    queryKey: ['transfers', restaurantId, direction, 'in_transit'],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      get<StockTransferView[]>(
        `/v1/restaurants/${restaurantId}/inventory/transfers?direction=${direction}&status=in_transit&limit=200`,
        token,
        signal,
      ),
  });
  const arriving = useQuery(open('incoming'));
  const sentOpen = useQuery(open('outgoing'));
  const waiting = arriving.data ?? [];
  const onItsWay = sentOpen.data ?? [];
  const history = [...(incoming.data ?? []), ...(outgoing.data ?? [])]
    .filter((t) => t.status !== 'in_transit')
    .sort((a, b) => b.dispatchedAt.localeCompare(a.dispatchedAt));

  return (
    <div className="space-y-5">
      <section aria-label="Arriving">
        <h2 className="mb-2 font-bold">Arriving</h2>
        {arriving.isPending ? (
          <Spinner label="Loading transfers" />
        ) : arriving.isError ? (
          <EmptyState title="Cannot load transfers" hint={arriving.error.message} />
        ) : waiting.length === 0 ? (
          <EmptyState className="py-6" title="Nothing on its way here" />
        ) : (
          <div className="space-y-3">
            {waiting.map((t) => (
              <ReceiveTransfer key={t.id} transfer={t} {...props} />
            ))}
          </div>
        )}
      </section>
      {onItsWay.length > 0 && (
        <section aria-label="On its way">
          <h2 className="mb-2 font-bold">Sent, not yet received</h2>
          <div className="space-y-3">
            {onItsWay.map((t) => (
              <CancelTransfer key={t.id} transfer={t} {...props} />
            ))}
          </div>
        </section>
      )}
      <SendTransfer {...props} />
      <section aria-label="Transfer history">
        <h2 className="mb-2 font-bold">Recent transfers</h2>
        {outgoing.isPending || incoming.isPending ? (
          <Spinner label="Loading transfers" />
        ) : outgoing.isError || incoming.isError ? (
          <EmptyState
            title="Cannot load transfers"
            hint={(outgoing.error ?? incoming.error)?.message}
          />
        ) : history.length === 0 ? (
          <EmptyState className="py-6" title="No transfers yet" />
        ) : (
          <Card className="divide-y divide-line">
            {history.map((t) => {
              const out = t.from.id === restaurantId;
              return (
                <div
                  key={t.id}
                  data-testid="transfer-row"
                  className="flex flex-wrap justify-between gap-2 px-3 py-2 text-sm"
                >
                  <span>
                    {out ? `To ${t.to.name}` : `From ${t.from.name}`}{' '}
                    <span className="text-ink-muted">
                      · {new Date(t.dispatchedAt).toLocaleString('en-AU')} ·{' '}
                      {STATUS_LABEL[t.status]}
                    </span>
                  </span>
                  <span className="tabular-nums">
                    {money(t.sentCents)}
                    {t.shortageCents ? (
                      <span className="ml-2 font-semibold text-danger" data-testid="shortage">
                        {money(t.shortageCents)} short
                      </span>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </Card>
        )}
      </section>
    </div>
  );
}

function ReceiveTransfer({
  transfer,
  restaurantId,
  token,
}: Props & { transfer: StockTransferView }) {
  const qc = useQueryClient();
  const attempt = useAttemptKey();
  // Starts at what was sent: the usual case is that everything arrived.
  const [received, setReceived] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      transfer.lines.map((l) => [l.inventoryItemId, trimQuantity(l.quantitySent)]),
    ),
  );
  const [notes, setNotes] = useState('');
  const over = transfer.lines.some((l) => {
    const v = received[l.inventoryItemId] ?? '';
    return isQuantity(v) && parseDecimalQty(v.trim()) > parseDecimalQty(l.quantitySent);
  });
  const valid = !over && transfer.lines.every((l) => isQuantity(received[l.inventoryItemId] ?? ''));

  const submit = useMutation({
    mutationFn: async (body: ReceiveTransferRequest) =>
      (
        await api<StockTransferView>(
          `/v1/restaurants/${restaurantId}/inventory/transfers/${transfer.id}/receive`,
          { method: 'POST', token, body, idempotencyKey: attempt.keyFor(body) },
        )
      ).data,
    onSuccess: () => {
      attempt.settle();
      void qc.invalidateQueries({ queryKey: ['transfers', restaurantId] });
      void qc.invalidateQueries({ queryKey: ['balances', restaurantId] });
      void qc.invalidateQueries({ queryKey: ['movements', restaurantId] });
    },
    onError: (err) => {
      attempt.settle(err);
      // Received elsewhere or cancelled by the sender meanwhile: refresh so this card goes away.
      if (
        err instanceof ApiError &&
        (err.code === 'TRANSFER_ALREADY_RECEIVED' || err.code === 'TRANSFER_CANCELLED')
      ) {
        void qc.invalidateQueries({ queryKey: ['transfers', restaurantId] });
      }
    },
  });

  return (
    <Card className="p-4">
      <form
        aria-label={`Receive transfer from ${transfer.from.name}`}
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid || submit.isPending) return;
          submit.mutate({
            ...(notes.trim() ? { notes: notes.trim() } : {}),
            lines: transfer.lines.map((l) => ({
              inventoryItemId: l.inventoryItemId,
              quantityReceived: received[l.inventoryItemId]!.trim(),
            })),
          });
        }}
      >
        <p className="font-semibold">From {transfer.from.name}</p>
        <p className="text-sm text-ink-muted">
          Sent by {transfer.dispatchedBy} ·{' '}
          {new Date(transfer.dispatchedAt).toLocaleString('en-AU')}
          {transfer.notes ? ` · “${transfer.notes}”` : ''}
        </p>
        <p className="mt-2 text-sm">
          Enter what actually arrived. Anything less is recorded as short.
        </p>
        <div className="mt-2 space-y-2">
          {transfer.lines.map((l) => (
            <label key={l.inventoryItemId} className="grid grid-cols-[1fr_8rem] items-center gap-2">
              <span className="text-sm">
                {l.name}{' '}
                <span className="text-ink-subtle">
                  (sent {trimQuantity(l.quantitySent)} {l.baseUnit})
                </span>
              </span>
              <input
                inputMode="decimal"
                aria-label={`${l.name} received`}
                className={inputClass}
                value={received[l.inventoryItemId] ?? ''}
                onChange={(e) =>
                  setReceived((r) => ({ ...r, [l.inventoryItemId]: e.target.value }))
                }
              />
            </label>
          ))}
        </div>
        <label className="mt-2 block text-sm">
          <span className="font-medium">Notes (optional)</span>
          <input
            className={inputClass}
            maxLength={500}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        {over && (
          <p role="alert" className="mt-2 text-sm text-danger">
            More cannot arrive than was sent. Record any extra with a stock count.
          </p>
        )}
        {submit.isError && outcomeUnknown(submit.error) && (
          <p role="alert" className="mt-2 text-sm font-medium text-danger">
            {OUTCOME_UNKNOWN_HINT}
          </p>
        )}
        {submit.isError && (
          <p role="alert" className="mt-2 rounded-lg bg-danger-soft p-3 text-sm text-danger">
            {submit.error.message}
          </p>
        )}
        <Button type="submit" className="mt-3" loading={submit.isPending} disabled={!valid}>
          Record arrival
        </Button>
      </form>
    </Card>
  );
}

/**
 * The sender takes back a transfer that has not been received: the stock is back on its
 * shelf at the value it left with. Once received, it can only be sent back as a new transfer.
 */
function CancelTransfer({
  transfer,
  restaurantId,
  token,
}: Props & { transfer: StockTransferView }) {
  const qc = useQueryClient();
  const attempt = useAttemptKey();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const valid = reason.trim().length >= 3;

  const submit = useMutation({
    mutationFn: async (body: CancelTransferRequest) =>
      (
        await api<StockTransferView>(
          `/v1/restaurants/${restaurantId}/inventory/transfers/${transfer.id}/cancel`,
          { method: 'POST', token, body, idempotencyKey: attempt.keyFor(body) },
        )
      ).data,
    onSuccess: () => {
      attempt.settle();
      void qc.invalidateQueries({ queryKey: ['transfers', restaurantId] });
      void qc.invalidateQueries({ queryKey: ['balances', restaurantId] });
      void qc.invalidateQueries({ queryKey: ['movements', restaurantId] });
    },
    onError: (err) => {
      attempt.settle(err);
      if (
        err instanceof ApiError &&
        (err.code === 'TRANSFER_ALREADY_RECEIVED' || err.code === 'TRANSFER_CANCELLED')
      ) {
        void qc.invalidateQueries({ queryKey: ['transfers', restaurantId] });
      }
    },
  });

  return (
    <section aria-label={`Sent to ${transfer.to.name}`} data-testid="outgoing-transfer">
      <Card className="p-4">
        <p className="font-semibold">To {transfer.to.name}</p>
        <p className="text-sm text-ink-muted">
          Sent by {transfer.dispatchedBy} ·{' '}
          {new Date(transfer.dispatchedAt).toLocaleString('en-AU')} · {money(transfer.sentCents)} in
          transit
          {transfer.notes ? ` · “${transfer.notes}”` : ''}
        </p>
        <ul className="mt-1 text-sm">
          {transfer.lines.map((l) => (
            <li key={l.inventoryItemId}>
              {trimQuantity(l.quantitySent)} {l.baseUnit} {l.name}
            </li>
          ))}
        </ul>
        {!open ? (
          <Button type="button" variant="secondary" className="mt-3" onClick={() => setOpen(true)}>
            Cancel transfer
          </Button>
        ) : (
          <form
            aria-label={`Cancel transfer to ${transfer.to.name}`}
            className="mt-3 space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!valid || submit.isPending) return;
              submit.mutate({ reason: reason.trim() });
            }}
          >
            <p className="text-sm">
              Only if the stock never left or has come back: it goes back on this restaurant&apos;s
              shelf, and {transfer.to.name} can no longer receive it.
            </p>
            <label className="block text-sm">
              <span className="font-medium">Reason</span>
              <input
                className={inputClass}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            {submit.isError && outcomeUnknown(submit.error) && (
              <p role="alert" className="text-sm font-medium text-danger">
                {OUTCOME_UNKNOWN_HINT}
              </p>
            )}
            {submit.isError && (
              <p role="alert" className="rounded-lg bg-danger-soft p-3 text-sm text-danger">
                {submit.error.message}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" loading={submit.isPending} disabled={!valid}>
                Cancel transfer and return stock
              </Button>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Keep it
              </Button>
            </div>
          </form>
        )}
      </Card>
    </section>
  );
}

const STATUS_LABEL: Record<StockTransferView['status'], string> = {
  in_transit: 'In transit',
  received: 'Received',
  cancelled: 'Cancelled',
};

interface SendLine {
  key: number;
  inventoryItemId: string;
  quantity: string;
}

function SendTransfer({ restaurantId, token }: Props) {
  const qc = useQueryClient();
  const attempt = useAttemptKey();
  const balances = useQuery({
    queryKey: ['balances', restaurantId],
    queryFn: ({ signal }) =>
      get<StockBalanceView[]>(`/v1/restaurants/${restaurantId}/inventory/balances`, token, signal),
  });
  const destinations = useQuery({
    queryKey: ['transfer-destinations', restaurantId],
    queryFn: ({ signal }) =>
      get<TransferDestination[]>(
        `/v1/restaurants/${restaurantId}/inventory/transfer-destinations`,
        token,
        signal,
      ),
  });
  const [to, setTo] = useState('');
  const [notes, setNotes] = useState('');
  const [nextKey, setNextKey] = useState(1);
  const [lines, setLines] = useState<SendLine[]>([{ key: 0, inventoryItemId: '', quantity: '' }]);
  const patch = (key: number, p: Partial<SendLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const ids = lines.map((l) => l.inventoryItemId).filter(Boolean);
  const duplicated = new Set(ids).size !== ids.length;
  const valid =
    to !== '' &&
    !duplicated &&
    lines.every((l) => l.inventoryItemId && isPositiveQuantity(l.quantity));

  const send = useMutation({
    mutationFn: async (body: StockTransferRequest) =>
      (
        await api<StockTransferView>(`/v1/restaurants/${restaurantId}/inventory/transfers`, {
          method: 'POST',
          token,
          body,
          idempotencyKey: attempt.keyFor(body),
        })
      ).data,
    onSuccess: () => {
      attempt.settle();
      setNotes('');
      setLines([{ key: nextKey, inventoryItemId: '', quantity: '' }]);
      setNextKey((k) => k + 1);
      void qc.invalidateQueries({ queryKey: ['transfers', restaurantId] });
      void qc.invalidateQueries({ queryKey: ['balances', restaurantId] });
      void qc.invalidateQueries({ queryKey: ['movements', restaurantId] });
    },
    onError: (err) => attempt.settle(err),
  });

  if (balances.isPending || destinations.isPending) return <Spinner label="Loading" />;
  if (balances.isError)
    return <EmptyState title="Cannot load items" hint={balances.error.message} />;
  if (destinations.isError)
    return <EmptyState title="Cannot load restaurants" hint={destinations.error.message} />;

  return (
    <Card className="p-4">
      <h2 className="font-bold">Send stock</h2>
      <form
        aria-label="Send stock"
        className="mt-3 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid || send.isPending) return;
          send.mutate({
            toRestaurantId: to,
            ...(notes.trim() ? { notes: notes.trim() } : {}),
            lines: lines.map((l) => ({
              inventoryItemId: l.inventoryItemId,
              quantity: l.quantity.trim(),
            })),
          });
        }}
      >
        <label className="block text-sm">
          <span className="font-medium">Send to</span>
          <select className={inputClass} value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Choose a restaurant</option>
            {destinations.data.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        {lines.map((l, i) => {
          const b = balances.data.find((x) => x.inventoryItemId === l.inventoryItemId);
          return (
            <fieldset
              key={l.key}
              aria-label={`Transfer line ${i + 1}`}
              className="grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-[1fr_9rem_auto]"
            >
              <label className="block text-sm">
                <span className="font-medium">Item</span>
                <select
                  className={inputClass}
                  value={l.inventoryItemId}
                  onChange={(e) => patch(l.key, { inventoryItemId: e.target.value })}
                >
                  <option value="">Choose an item</option>
                  {balances.data.map((x) => (
                    <option key={x.inventoryItemId} value={x.inventoryItemId}>
                      {x.name} ({x.baseUnit})
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="font-medium">Quantity{b ? ` (${b.baseUnit})` : ''}</span>
                <input
                  inputMode="decimal"
                  className={inputClass}
                  value={l.quantity}
                  onChange={(e) => patch(l.key, { quantity: e.target.value })}
                />
                {b && (
                  <span className="text-xs text-ink-muted">
                    {trimQuantity(b.available)} available
                  </span>
                )}
              </label>
              <div className="flex items-end">
                {lines.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </fieldset>
          );
        })}
        {duplicated && (
          <p role="alert" className="text-sm text-danger">
            Each item can appear once on a transfer.
          </p>
        )}
        <label className="block text-sm">
          <span className="font-medium">Notes (optional)</span>
          <input
            className={inputClass}
            maxLength={500}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        {send.isError && outcomeUnknown(send.error) && (
          <p role="alert" className="text-sm font-medium text-danger">
            {OUTCOME_UNKNOWN_HINT}
          </p>
        )}
        {send.isError && (
          <p role="alert" className="rounded-lg bg-danger-soft p-3 text-sm text-danger">
            {send.error.message}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setLines((ls) => [...ls, { key: nextKey, inventoryItemId: '', quantity: '' }]);
              setNextKey((k) => k + 1);
            }}
          >
            Add another item
          </Button>
          <Button type="submit" loading={send.isPending} disabled={!valid}>
            Send stock
          </Button>
        </div>
      </form>
      {send.isSuccess && (
        <p
          role="status"
          data-testid="transfer-sent"
          className="mt-3 rounded-lg bg-canvas p-3 text-sm"
        >
          Sent to {send.data.to.name}: {money(send.data.sentCents)} of stock now in transit.
        </p>
      )}
    </Card>
  );
}
