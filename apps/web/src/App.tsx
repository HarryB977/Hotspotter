import { useEffect } from 'react';
import { es } from './i18n/es';
import { useProject } from './state/store';
import { MaterialPanel } from './panels/MaterialPanel';
import { ChecksPanel } from './panels/ChecksPanel';
import { TooltipProvider } from './components/ui/tooltip';
import { Tabs, TabsList, TabsTrigger } from './components/ui/tabs';
import { StackPanel } from './panels/StackPanel';
import { Inspector } from './panels/Inspector';
import { AtlasView } from './viewport/AtlasView';
import { ViewportSplit } from './viewport/ViewportSplit';
import { View3DPane } from './viewport/View3D';
import { ExportDialog } from './export/ExportDialog';
import { FileMenu, ProjectName } from './project/FileMenu';
import { MAP_TABS } from './state/store';
import type { ActiveMap } from './state/store';
import { mapLabel } from './viewport/mapLabel';

function PanelTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-6 shrink-0 items-center border-b border-zinc-800 px-2 text-xs uppercase tracking-wide text-zinc-500">
      {children}
    </div>
  );
}

export function App() {
  const error = useProject((s) => s.error);
  const gpu = useProject((s) => s.gpu);
  const atlas = useProject((s) => s.atlas);
  const activeMap = useProject((s) => s.activeMap);
  const setActiveMap = useProject((s) => s.setActiveMap);
  const composeError = useProject((s) => s.composeError);
  const checks = useProject((s) => s.checks);
  const flagged = checks?.results.filter((r) => r.status !== 'ok') ?? [];
  const flaggedClass = flagged.some((r) => r.status === 'error')
    ? 'text-red-500'
    : flagged.length > 0 ? 'text-amber-400' : undefined;

  useEffect(() => {
    void useProject.getState().initGpu();
  }, []);

  if (error) {
    return (
      <div
        className="flex h-full items-center justify-center bg-zinc-950 p-8 text-center text-lg text-zinc-200"
        data-testid="webgpu-error"
      >
        {error}
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={400}>
      <div className="grid h-full grid-cols-[240px_minmax(0,1fr)_280px] grid-rows-[30px_minmax(0,1fr)_28px] overflow-hidden">
        <header className="col-span-3 flex min-w-0 items-center gap-3 border-b border-zinc-800 bg-zinc-900 px-2">
          <span className="font-semibold text-zinc-100">{es.appName}</span>
          <FileMenu />
          <ProjectName />
          <span className="ml-auto"><ExportDialog /></span>
        </header>
        {/* R45: the Material panel scrolls in its own area so the Pila and the checks always stay on screen; the
            column's own scroll is a fallback for very short windows. */}
        <aside
          className="flex min-h-0 flex-col overflow-y-auto border-r border-zinc-800 bg-zinc-900"
          data-testid="left-column"
        >
          <div className="min-h-[120px] flex-1 overflow-y-auto" data-testid="material-scroll">
            <MaterialPanel />
          </div>
          <div className="shrink-0">
            <StackPanel />
            <ChecksPanel />
          </div>
        </aside>
        <main className="flex min-h-0 min-w-0 flex-col bg-zinc-950">
          <ViewportSplit
            left={atlas ? (
              <AtlasView maps={atlas.maps} layout={atlas.layout} activeMap={activeMap} issues={atlas.issues} />
            ) : (
              <div className="flex flex-1 items-center justify-center text-zinc-600">{es.atlas.empty}</div>
            )}
            right={<View3DPane />}
          />
        </main>
        <aside className="flex min-h-0 flex-col border-l border-zinc-800 bg-zinc-900">
          <PanelTitle>{es.inspector.title}</PanelTitle>
          <Inspector />
        </aside>
        <footer className="col-span-3 flex min-w-0 items-stretch justify-between overflow-hidden border-t border-zinc-800 bg-zinc-900">
          <Tabs value={activeMap} onValueChange={(v) => setActiveMap(v as ActiveMap)} className="h-full">
            <TabsList className="h-full">
              {MAP_TABS.map((k) => (
                <TabsTrigger key={k} value={k} disabled={!atlas}>
                  {mapLabel(k)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <span className="flex min-w-0 items-center gap-3 px-2 text-zinc-500">
            {composeError && (
              <span className="truncate text-red-400" title={composeError} data-testid="compose-error">
                {composeError}
              </span>
            )}
            {atlas && (
              <>
                {checks && (
                  <span
                    className={flaggedClass}
                    title={es.checks.counter(flagged.length)}
                    data-testid="checks-warnings"
                  >
                    {`${es.checks.title}: ${flagged.length}`}
                  </span>
                )}
                <span
                  className={atlas.issues.length > 0 ? 'text-amber-400' : undefined}
                  title={es.mapBar.issues(atlas.issues.length, atlas.layoutIssues.length)}
                  data-testid="proportion-issues"
                >
                  {atlas.issues.length}
                </span>
                <span className="tabular-nums" data-testid="atlas-info">
                  {`${atlas.resolutionPx}² · ${Math.round(atlas.resolutionPx / atlas.layout.worldWidthM)} px/m · GPU ${Math.round(atlas.gpuMs)} ms`}
                </span>
              </>
            )}
            <span data-testid="gpu-info">{gpu ? gpu.adapterInfo : ''}</span>
          </span>
        </footer>
      </div>
    </TooltipProvider>
  );
}
