import { useState } from 'react';
import type { ExportPreset } from '@hotspotter/core';
import { es } from '../i18n/es';
import { useProject } from '../state/store';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '../components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { ExportUploadError, exportProject } from './encode';

const DIR_KEY = 'hotspotter.exportDir';
const RESOLUTIONS = [1024, 2048, 4096, 8192];

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
  const [res, setRes] = useState(4096);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ index: number; total: number; name: string } | null>(null);
  const [paths, setPaths] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    saveDir(dir);
    setBusy(true);
    setError(null);
    setPaths(null);
    setProgress(null);
    try {
      setPaths(
        await exportProject({
          dir,
          preset,
          resolutionPx: res,
          onProgress: (index, total, name) => setProgress({ index, total, name }),
        }),
      );
    } catch (e) {
      setError(e instanceof ExportUploadError ? es.export.serverError(e.message) : es.export.failed(String(e)));
    } finally {
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
              <Select value={String(res)} onValueChange={(v) => setRes(Number(v))}>
                <SelectTrigger data-testid="export-res"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {RESOLUTIONS.map((r) => <SelectItem key={r} value={String(r)}>{String(r)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
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
