import { CircleAlert, CircleCheck, CircleX } from 'lucide-react';
import type { CheckResult, CheckStatus } from '@hotspotter/core';
import { es } from '../i18n/es';
import { useProject } from '../state/store';
import { Section } from './MaterialPanel';

const ICON: Record<CheckStatus, { Icon: typeof CircleCheck; className: string }> = {
  ok: { Icon: CircleCheck, className: 'text-green-500' },
  warn: { Icon: CircleAlert, className: 'text-amber-400' },
  error: { Icon: CircleX, className: 'text-red-500' },
};

/** One check: icon, name and, unless ok, its message. A row with `onFocus` is a button that shows the problem. */
export function CheckRow({ r, onFocus, testId = 'check-row' }: { r: CheckResult; onFocus?: () => void; testId?: string }) {
  const { Icon, className } = ICON[r.status];
  const body = (
    <>
      <span className="flex items-center gap-1.5">
        <Icon className={`size-3.5 shrink-0 ${className}`} aria-label={es.checks.status[r.status]} />
        <span className="truncate text-zinc-200">{es.checks.names[r.id]}</span>
      </span>
      {r.status !== 'ok' && <span className="pl-5 text-left leading-snug text-zinc-400">{r.message}</span>}
    </>
  );
  const common = {
    'data-testid': testId,
    'data-check-id': r.id,
    'data-status': r.status,
    title: r.message,
  };
  if (!onFocus) return <div {...common} className="flex flex-col gap-0.5 py-0.5">{body}</div>;
  return (
    <button
      type="button"
      {...common}
      title={`${r.message} ${es.checks.focusHint}`}
      className={
        'flex flex-col gap-0.5 rounded-sm py-0.5 text-left hover:bg-zinc-800 ' +
        'focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-500'
      }
      onClick={onFocus}
    >
      {body}
    </button>
  );
}

/** The automatic checks of docs/04-wear.md; a row with points centres the atlas on the first one. */
export function ChecksPanel() {
  const checks = useProject((s) => s.checks);
  const error = useProject((s) => s.checksError);
  const hasAtlas = useProject((s) => s.atlas !== null);
  const focusAtlas = useProject((s) => s.focusAtlas);
  const pending = useProject((s) => s.checksPending);
  if (!hasAtlas) return null;
  return (
    <Section title={es.checks.title}>
      <div
        className={`flex flex-col ${pending && checks ? 'opacity-50' : ''}`}
        data-testid="checks"
        data-pending={pending ? 'true' : undefined}
      >
        {error && <div className="text-red-400" data-testid="checks-error">{error}</div>}
        {(pending || !checks) && !error && (
          <div className="text-zinc-500" data-testid="checks-pending">{es.checks.pending}</div>
        )}
        {checks?.results.map((r) => {
          const p = r.points?.[0];
          // Results of an older atlas are shown dimmed and never move the view.
          return (
            <CheckRow
              key={r.id}
              r={r}
              onFocus={p && !pending ? () => focusAtlas(p[0] / checks.width, p[1] / checks.height) : undefined}
            />
          );
        })}
      </div>
    </Section>
  );
}
