import { useEffect, useState } from 'react';
import { es } from '../i18n/es';

type UpdateState =
  | { status: 'none' }
  | { status: 'available'; version: string; notes: string; url: string }
  | { status: 'authError' };

/** The server's update state; a missing route (dev) or any failure counts as no update. */
async function fetchUpdate(): Promise<UpdateState> {
  try {
    const res = await fetch('/api/update');
    if (!res.ok) return { status: 'none' };
    const json = (await res.json()) as Partial<UpdateState> & { status?: string };
    if (json.status === 'available' && typeof json.version === 'string' && typeof json.url === 'string') {
      return { status: 'available', version: json.version, notes: typeof json.notes === 'string' ? json.notes : '', url: json.url };
    }
    if (json.status === 'authError') return { status: 'authError' };
  } catch {
    // Offline or not the packaged server: show nothing.
  }
  return { status: 'none' };
}

const BTN = 'rounded px-1.5 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100';

/** Compact notice for the status bar: a newer stable release, or why updates cannot be checked. */
export function UpdateNotice() {
  const [state, setState] = useState<UpdateState>({ status: 'none' });
  const [hidden, setHidden] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);

  useEffect(() => {
    let live = true;
    void fetchUpdate().then((s) => { if (live) setState(s); });
    return () => { live = false; };
  }, []);

  if (hidden || state.status === 'none') return null;

  if (state.status === 'authError') {
    return (
      <span className="flex items-center gap-1 text-zinc-500" data-testid="update-auth-error">
        <span className="truncate">{es.update.authError}</span>
        <button type="button" className={BTN} aria-label={es.update.dismiss} onClick={() => setHidden(true)}>×</button>
      </span>
    );
  }

  const { version, notes, url } = state;
  const skip = () => {
    setHidden(true);
    void fetch('/api/update/skip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hotspotter': '1' },
      body: JSON.stringify({ version }),
    }).catch(() => undefined);
  };

  return (
    <span className="relative flex shrink-0 items-center gap-1 text-zinc-300" data-testid="update-notice">
      <span className="text-sky-400">{es.update.available(version)}</span>
      <button type="button" className={BTN} aria-expanded={notesOpen} onClick={() => setNotesOpen((o) => !o)}>
        {es.update.notes}
      </button>
      <button
        type="button"
        className={BTN}
        onClick={() => window.open(url, '_blank', 'noopener')}
      >
        {es.update.download}
      </button>
      <button type="button" className={BTN} onClick={() => setHidden(true)}>{es.update.later}</button>
      <button type="button" className={BTN} onClick={skip}>{es.update.skip}</button>
      {notesOpen && (
        // Fixed, so the footer's overflow clipping does not cut it. Plain text: release notes are never rendered as HTML.
        <div
          className="fixed bottom-8 right-2 z-50 max-h-64 w-96 overflow-y-auto whitespace-pre-wrap rounded border border-zinc-700 bg-zinc-900 p-2 text-zinc-300 shadow-lg"
          data-testid="update-notes"
        >
          {notes || es.update.noNotes}
        </div>
      )}
    </span>
  );
}
