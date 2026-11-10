import type { WasteRecordView } from '@kitchos/contracts';
import { Badge } from '@/components/ui';
import { money, trimQuantity } from '@/lib/format';

export const inputClass = 'mt-1 h-11 w-full rounded-lg border border-line bg-paper px-3 text-sm';

export const WASTE_REASON_LABEL: Record<WasteRecordView['reason'], string> = {
  expired: 'Expired',
  spoiled: 'Spoiled',
  dropped: 'Dropped',
  spilled: 'Spilled',
  burnt: 'Burnt',
  incorrect_order: 'Incorrect order',
  poor_quality: 'Poor quality',
  overproduction: 'Overproduction',
  equipment_failure: 'Equipment failure',
  temperature_breach: 'Temperature breach',
  cancelled_prepared_order: 'Cancelled after preparation',
  other: 'Other',
};

const STATUS = {
  recorded: ['Recorded', 'neutral'],
  pending_approval: ['Needs approval', 'warn'],
  approved: ['Approved', 'ok'],
  rejected: ['Rejected', 'danger'],
} as const;

export function WasteSummaryLine({ w }: { w: WasteRecordView }) {
  const [label, tone] = STATUS[w.status];
  const reclassified = w.lines.some((l) => l.treatment === 'already_consumed');
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <p className="font-semibold">
          {trimQuantity(w.quantity)} × {w.itemName} · {money(w.costCents)}
        </p>
        <p className="text-sm text-ink-muted">
          {WASTE_REASON_LABEL[w.reason]}
          {w.stationName && ` · ${w.stationName}`} · {w.recordedBy} ·{' '}
          {new Date(w.occurredAt).toLocaleString('en-AU')}
        </p>
        {reclassified && (
          <p className="text-xs text-ink-muted">
            Already used in production, so stock was not deducted again.
          </p>
        )}
        {w.remake && <p className="text-xs text-ink-muted">Remade for the same order.</p>}
        {w.notes && <p className="text-xs text-ink-muted">{w.notes}</p>}
        {w.reviewedBy && (
          <p className="text-xs text-ink-muted">
            {label} by {w.reviewedBy}: {w.reviewReason}
          </p>
        )}
      </div>
      <Badge tone={tone}>{label}</Badge>
    </div>
  );
}
