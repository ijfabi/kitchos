import { clsx } from 'clsx';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'ops' | 'ops-primary';
type Size = 'sm' | 'md' | 'lg' | 'xl';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-strong disabled:bg-brand/50',
  secondary: 'bg-paper text-ink border border-line hover:bg-canvas disabled:text-ink-subtle',
  ghost: 'text-ink-muted hover:bg-black/5',
  danger: 'bg-danger text-white hover:bg-danger/90 disabled:bg-danger/50',
  ops: 'bg-ops-raised text-ops-text border border-ops-line hover:bg-ops-line disabled:opacity-50',
  'ops-primary': 'bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50',
};
const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-5 text-base',
  xl: 'h-16 px-6 text-lg',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

type Tone = 'neutral' | 'brand' | 'ok' | 'warn' | 'danger' | 'info';
const TONES: Record<Tone, string> = {
  neutral: 'bg-canvas text-ink-muted border-line',
  brand: 'bg-brand-soft text-brand-strong border-brand/20',
  ok: 'bg-ok-soft text-ok border-ok/20',
  warn: 'bg-warn-soft text-warn border-warn/20',
  danger: 'bg-danger-soft text-danger border-danger/20',
  info: 'bg-info-soft text-info border-info/20',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('rounded-xl border border-line bg-paper shadow-sm', className)}>
      {children}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-12 text-ink-muted">
      <Loader2 className="size-5 animate-spin" aria-hidden />
      <span>{label}…</span>
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-xl border border-danger/20 bg-danger-soft p-6 text-center"
    >
      <AlertTriangle className="size-6 text-danger" aria-hidden />
      <p className="font-semibold text-danger">{title}</p>
      <p className="text-sm text-ink-muted">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  className,
}: {
  title: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={clsx('flex flex-col items-center gap-1 py-12 text-center', className)}>
      <p className="font-semibold">{title}</p>
      {hint && <p className="text-sm opacity-70">{hint}</p>}
    </div>
  );
}

export function Logo({ className, inverted }: { className?: string; inverted?: boolean }) {
  return (
    <span className={clsx('inline-flex items-center gap-2 font-bold tracking-tight', className)}>
      <span
        aria-hidden
        className="grid size-7 place-items-center rounded-md bg-brand text-sm font-black text-white"
      >
        K
      </span>
      <span className={inverted ? 'text-ops-text' : 'text-ink'}>KitchOS</span>
    </span>
  );
}
