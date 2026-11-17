import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type UpdateState =
  | { status: 'none' }
  | { status: 'available'; version: string; notes: string; url: string }
  | { status: 'authError' };

export interface UpdateService {
  state(): Promise<UpdateState>;
  skip(version: string): Promise<void>;
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STABLE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** Compares stable x.y.z versions (a leading 'v' is allowed). Returns <0, 0 or >0. */
export function compareSemver(a: string, b: string): number {
  const pa = STABLE.exec(a.trim());
  const pb = STABLE.exec(b.trim());
  if (!pa || !pb) throw new Error(`Not a stable semver: ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

const bare = (v: string): string => v.trim().replace(/^v/, '');

/** What the last successful check found; skipped and current versions are applied when reading. */
type Latest =
  | { kind: 'none' }
  | { kind: 'authError' }
  | { kind: 'release'; version: string; notes: string; url: string };

interface Persisted {
  lastCheck: number;
  latest: Latest;
  skipped: string[];
}

function isLatest(v: unknown): v is Latest {
  if (typeof v !== 'object' || v === null) return false;
  const k = (v as { kind?: unknown }).kind;
  if (k === 'none' || k === 'authError') return true;
  const r = v as Record<string, unknown>;
  return k === 'release' && typeof r.version === 'string' && typeof r.notes === 'string' && typeof r.url === 'string';
}

export function createUpdateService(o: {
  currentVersion: string;
  token?: string;
  dir: string;
  fetch?: typeof fetch;
  now?: () => number;
  repo?: string;
}): UpdateService {
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const repo = o.repo ?? 'HarryB977/Hotspotter';
  const file = join(o.dir, 'updates.json');

  async function load(): Promise<Persisted> {
    const empty: Persisted = { lastCheck: 0, latest: { kind: 'none' }, skipped: [] };
    try {
      const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (typeof raw !== 'object' || raw === null) return empty;
      const r = raw as Record<string, unknown>;
      return {
        lastCheck: typeof r.lastCheck === 'number' ? r.lastCheck : 0,
        latest: isLatest(r.latest) ? r.latest : { kind: 'none' },
        skipped: Array.isArray(r.skipped) ? r.skipped.filter((s): s is string => typeof s === 'string') : [],
      };
    } catch {
      return empty;
    }
  }

  async function save(p: Persisted): Promise<void> {
    try {
      await mkdir(o.dir, { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(p), 'utf8');
      await rename(tmp, file);
    } catch (err) {
      console.error('update state not saved:', err instanceof Error ? err.message : 'unknown error');
    }
  }

  async function query(): Promise<Latest | null> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': `Hotspotter/${o.currentVersion}`,
    };
    if (o.token) headers.Authorization = `Bearer ${o.token}`;
    try {
      const res = await doFetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
      if (res.status === 401 || res.status === 403) return { kind: 'authError' };
      if (!res.ok) {
        console.error('update check failed: HTTP', res.status);
        return null;
      }
      const body = (await res.json()) as { tag_name?: unknown; body?: unknown; html_url?: unknown };
      const tag = typeof body.tag_name === 'string' ? body.tag_name : '';
      if (!STABLE.test(tag)) return { kind: 'none' };
      return {
        kind: 'release',
        version: bare(tag),
        notes: typeof body.body === 'string' ? body.body : '',
        url: typeof body.html_url === 'string' ? body.html_url : '',
      };
    } catch (err) {
      console.error('update check failed:', err instanceof Error ? err.message : 'unknown error');
      return null;
    }
  }

  function toState(p: Persisted): UpdateState {
    const l = p.latest;
    if (l.kind === 'authError') return { status: 'authError' };
    if (l.kind !== 'release') return { status: 'none' };
    if (compareSemver(l.version, o.currentVersion) <= 0) return { status: 'none' };
    if (p.skipped.map(bare).includes(l.version)) return { status: 'none' };
    return { status: 'available', version: l.version, notes: l.notes, url: l.url };
  }

  return {
    async state() {
      const p = await load();
      if (now() - p.lastCheck >= CHECK_INTERVAL_MS || p.lastCheck > now()) {
        const latest = await query();
        // A failed check (network, 5xx) reports none and is retried on the next call.
        if (!latest) return { status: 'none' };
        p.latest = latest;
        p.lastCheck = now();
        await save(p);
      }
      return toState(p);
    },
    async skip(version) {
      const p = await load();
      const v = bare(version);
      if (!p.skipped.includes(v)) p.skipped.push(v);
      await save(p);
    },
  };
}
