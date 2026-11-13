import { useState } from 'react';
import type { CheckResult, DocNode, ExportPreset, ProjectDoc } from '@hotspotter/core';
import { es } from '../i18n/es';
import { useProject } from '../state/store';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '../components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { CheckRow } from '../panels/ChecksPanel';
import { ExportUploadError, exportProject } from './encode';

const DIR_KEY = 'hotspotter.exportDir';
const RESOLUTIONS = [1024, 2048, 4096, 8192];

function outputNode(doc: ProjectDoc | null): DocNode<'output'> | undefined {
  return doc?.nodes.find((n): n is DocNode<'output'> => n.type === 'output');
}

function dirtNode(doc: ProjectDoc | null): DocNode<'dirt'> | undefined {
  return doc?.nodes.find((n): n is DocNode<'dirt'> => n.type === 'dirt');
}

function loadDir(): string {
  try {
    return localStorage.getItem(DIR_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveDir(dir: string): void {
  try {
    localStorage.setItem(DIR_KEY, dir);
  } catch {
    // Storage unavailable: the folder is simply not remembered.
  }
}

export function ExportDialog() {
  const hasProject = useProject((s) => s.doc !== null && s.gpuMaterial !== null);
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState(loadDir);
  const [preset, setPreset] = useState<ExportPreset>('unity-urp');
  // The output node holds the export resolution: the Checks panel and the export read the same value.
  const res = useProject((s) => outputNode(s.doc)?.params.resolutionPx ?? 4096);
  const runoff = useProject((s) => (dirtNode(s.doc)?.params.runoff ?? 0) > 0);
  const setRes = (r: number) => useProject.getState().updateNode<'output'>('output', { resolutionPx: r });
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [checksFailed, setChecksFailed] = useState(false);
  const [progress, setProgress] = useState<{ index: number; total: number; name: string } | null>(null);
  const [paths, setPaths] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    saveDir(dir);
    setBusy(true);
    setError(null);
    setPaths(null);
    setProgress(null);
    setChecks(null);
    setChecksFailed(false);
    try {
      // The checks at the export resolution; warnings never block the export, nor does a failed evaluation.
      setChecking(true);
      const results = await useProject.getState().runEvaluation({ exportResolutionPx: res, force: true });
      setChecking(false);
      setChecks(results);
      setChecksFailed(results === null);
      setPaths(
        await exportProject({
          dir,
          preset,
          resolutionPx: res,
          checks: results ?? undefined,
          onProgress: (index, total, name) => setProgress({ index, total, name }),
        }),
      );
    } catch (e) {
      setError(e instanceof ExportUploadError ? es.export.serverError(e.message) : es.export.failed(String(e)));
    } finally {
      setChecking(false);
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={!hasProject} data-testid="export-open">{es.export.button}</Button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle className="mb-2 text-sm font-semibold">{es.export.title}</DialogTitle>
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            {es.export.folder}
            <Input
              data-testid="export-dir"
              value={dir}
              placeholder={es.export.folderPlaceholder}
              onChange={(e) => setDir(e.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <div className="flex flex-1 flex-col gap-1 text-xs text-zinc-400">
              {es.export.preset}
              <Select value={preset} onValueChange={(v) => setPreset(v as ExportPreset)}>
                <SelectTrigger data-testid="export-preset"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="unity-urp">Unity URP</SelectItem>
                  <SelectItem value="unity-hdrp">Unity HDRP</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-1 flex-col gap-1 text-xs text-zinc-400">
              {es.export.resolution}
              <Select value={String(res)} onValueChange={(v) => setRes(Number(v))} disabled={busy}>
                <SelectTrigger data-testid="export-res"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(RESOLUTIONS.includes(res) ? RESOLUTIONS : [...RESOLUTIONS, res].sort((a, b) => a - b)).map((r) => (
                    <SelectItem key={r} value={String(r)}>{String(r)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {res === 8192 && (
            <div className="text-xs text-amber-400" data-testid="export-warning">{es.export.bigWarning}</div>
          )}
          {checking && <div className="text-xs text-zinc-400" data-testid="export-checking">{es.export.checking}</div>}
          {(checks || checksFailed) && (
            <div className="flex flex-col text-xs" data-testid="export-checks">
              <div className="text-zinc-400">{es.export.checksTitle}</div>
              {checksFailed && <div className="text-amber-400">{es.export.checksFailed}</div>}
              {checks?.map((r) => <CheckRow key={r.id} r={r} testId="export-check-row" />)}
              {checks?.some((r) => r.status !== 'ok') && <div className="text-zinc-500">{es.export.checksNote}</div>}
              {runoff && (
                <div className="mt-1 text-amber-400" data-testid="export-runoff-warning">{es.export.runoffWarning}</div>
              )}
            </div>
          )}
          {progress && busy && (
            <div className="text-xs text-zinc-400">
              <progress className="h-1 w-full" max={progress.total} value={progress.index} data-testid="export-progress" />
              {es.export.writing(Math.min(progress.index + 1, progress.total), progress.total, progress.name)}
            </div>
          )}
          {error && <div className="text-xs text-red-400" data-testid="export-error">{error}</div>}
          {paths && (
            <div className="text-xs text-zinc-300" data-testid="export-done">
              {es.export.done(paths.length)}
              <ul className="mt-1 max-h-32 overflow-y-auto break-all text-zinc-500">
                {paths.map((p) => <li key={p}>{p}</li>)}
              </ul>
            </div>
          )}
          <Button variant="default" disabled={busy || dir.trim() === ''} onClick={() => void run()} data-testid="export-run">
            {busy ? es.export.exporting : es.export.run}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
