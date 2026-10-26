'use client';

import type { MenuItemView, ModifierGroupView } from '@kitchos/contracts';
import { clsx } from 'clsx';
import { Minus, Plus, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Badge, Button } from '@/components/ui';
import { money } from '@/lib/format';

export interface CartLine {
  key: string;
  menuItemId: string;
  name: string;
  quantity: number;
  modifierOptionIds: string[];
  components: { componentId: string; modifierOptionIds: string[] }[];
  /** Display estimate only; the server prices every order. */
  unitPriceCents: number;
  summary: string[];
}

type Selection = Record<string, string[]>; // groupId -> optionIds

function groupError(group: ModifierGroupView, chosen: string[]): string | null {
  if (chosen.length < group.minSelect) return `Choose at least ${group.minSelect}`;
  if (chosen.length > group.maxSelect) return `Choose at most ${group.maxSelect}`;
  return null;
}

function GroupPicker({
  group,
  chosen,
  onChange,
}: {
  group: ModifierGroupView;
  chosen: string[];
  onChange: (next: string[]) => void;
}) {
  const single = group.maxSelect === 1;
  const err = groupError(group, chosen);
  const id = useId();
  return (
    <fieldset className="space-y-2" aria-describedby={`${id}-hint`}>
      <legend className="flex w-full items-center justify-between text-sm font-semibold">
        {group.name}
        <span id={`${id}-hint`} className="text-xs font-normal text-ink-subtle">
          {group.minSelect > 0 ? 'Required' : 'Optional'} · up to {group.maxSelect}
        </span>
      </legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {group.options.map((o) => {
          const on = chosen.includes(o.id);
          const toggle = () => {
            if (single) onChange(on ? [] : [o.id]);
            else if (on) onChange(chosen.filter((x) => x !== o.id));
            else if (chosen.length < group.maxSelect) onChange([...chosen, o.id]);
          };
          return (
            <label
              key={o.id}
              className={clsx(
                'flex min-h-12 cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm transition-colors',
                on ? 'border-brand bg-brand-soft' : 'border-line hover:bg-canvas',
              )}
            >
              <span className="flex items-center gap-2">
                <input
                  type={single ? 'radio' : 'checkbox'}
                  name={`${id}-${group.id}`}
                  checked={on}
                  onChange={toggle}
                  className="size-4 accent-[var(--color-brand)]"
                />
                {o.name}
              </span>
              {o.priceDeltaCents !== 0 && (
                <span className="text-ink-muted">+{money(o.priceDeltaCents)}</span>
              )}
            </label>
          );
        })}
      </div>
      {err && chosen.length > group.maxSelect && <p className="text-xs text-danger">{err}</p>}
    </fieldset>
  );
}

export function ItemDialog({
  item,
  onClose,
  onAdd,
}: {
  item: MenuItemView | null;
  onClose: () => void;
  onAdd: (line: CartLine) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [qty, setQty] = useState(1);
  const [itemSel, setItemSel] = useState<Selection>({});
  const [compSel, setCompSel] = useState<Record<string, Selection>>({});

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (item) {
      setQty(1);
      setItemSel({});
      setCompSel({});
      if (!d.open) d.showModal();
    } else if (d.open) d.close();
  }, [item]);

  const { unitPrice, summary, valid } = useMemo(() => {
    if (!item) return { unitPrice: 0, summary: [] as string[], valid: false };
    let price = item.priceCents;
    const names: string[] = [];
    let ok = true;
    for (const g of item.modifierGroups) {
      const chosen = itemSel[g.id] ?? [];
      if (groupError(g, chosen)) ok = false;
      for (const o of g.options.filter((x) => chosen.includes(x.id))) {
        price += o.priceDeltaCents;
        names.push(o.name);
      }
    }
    for (const c of item.components) {
      for (const g of c.modifierGroups) {
        const chosen = compSel[c.id]?.[g.id] ?? [];
        if (groupError(g, chosen)) ok = false;
        for (const o of g.options.filter((x) => chosen.includes(x.id))) {
          price += o.priceDeltaCents * c.quantity;
          names.push(`${c.name}: ${o.name}`);
        }
      }
    }
    return { unitPrice: price, summary: names, valid: ok };
  }, [item, itemSel, compSel]);

  if (!item) return <dialog ref={ref} />;

  const add = () => {
    onAdd({
      key: crypto.randomUUID(),
      menuItemId: item.id,
      name: item.name,
      quantity: qty,
      modifierOptionIds: Object.values(itemSel).flat(),
      components: item.components
        .map((c) => ({
          componentId: c.id,
          modifierOptionIds: Object.values(compSel[c.id] ?? {}).flat(),
        }))
        .filter((c) => c.modifierOptionIds.length > 0),
      unitPriceCents: unitPrice,
      summary,
    });
    onClose();
  };

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="item-dialog-title"
      className="m-auto w-[min(100vw-1.5rem,40rem)] rounded-2xl p-0 shadow-2xl backdrop:bg-black/50"
    >
      <div className="flex max-h-[85dvh] flex-col">
        <header className="flex items-start justify-between gap-4 border-b border-line p-5">
          <div>
            <h2 id="item-dialog-title" className="text-xl font-bold">
              {item.name}
            </h2>
            <p className="mt-1 text-sm text-ink-muted">{item.description}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {item.energyKj !== null && <Badge>{item.energyKj.toLocaleString('en-AU')} kJ</Badge>}
              {item.allergens.map((a) => (
                <Badge key={a} tone="warn">
                  Contains {a}
                </Badge>
              ))}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            <X className="size-5" />
          </Button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto p-5">
          {item.components.length > 0 && (
            <p className="text-sm text-ink-muted">
              Includes {item.components.map((c) => c.name).join(', ')}.
            </p>
          )}
          {item.modifierGroups.map((g) => (
            <GroupPicker
              key={g.id}
              group={g}
              chosen={itemSel[g.id] ?? []}
              onChange={(next) => setItemSel((s) => ({ ...s, [g.id]: next }))}
            />
          ))}
          {item.components
            .filter((c) => c.modifierGroups.length > 0)
            .map((c) => (
              <section key={c.id} className="space-y-4 rounded-xl bg-canvas p-4">
                <h3 className="font-semibold">Customise your {c.name}</h3>
                {c.modifierGroups.map((g) => (
                  <GroupPicker
                    key={g.id}
                    group={g}
                    chosen={compSel[c.id]?.[g.id] ?? []}
                    onChange={(next) =>
                      setCompSel((s) => ({ ...s, [c.id]: { ...s[c.id], [g.id]: next } }))
                    }
                  />
                ))}
              </section>
            ))}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-line p-4">
          <div className="flex items-center gap-1" role="group" aria-label="Quantity">
            <Button
              variant="secondary"
              size="lg"
              aria-label="Decrease quantity"
              disabled={qty <= 1}
              onClick={() => setQty((q) => q - 1)}
            >
              <Minus className="size-4" />
            </Button>
            <span className="w-10 text-center text-lg font-semibold" aria-live="polite">
              {qty}
            </span>
            <Button
              variant="secondary"
              size="lg"
              aria-label="Increase quantity"
              disabled={qty >= 20}
              onClick={() => setQty((q) => q + 1)}
            >
              <Plus className="size-4" />
            </Button>
          </div>
          <Button size="lg" onClick={add} disabled={!valid} className="flex-1 sm:flex-none">
            Add to order · {money(unitPrice * qty)}
          </Button>
        </footer>
      </div>
    </dialog>
  );
}
