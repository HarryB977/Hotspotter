import { useEffect } from 'react';
import { es } from './i18n/es';
import { useProject } from './state/store';
import { MaterialPanel } from './panels/MaterialPanel';
import { TooltipProvider } from './components/ui/tooltip';
import { Tabs, TabsList, TabsTrigger } from './components/ui/tabs';
import { LayoutPanel } from './panels/LayoutPanel';
import { Inspector } from './panels/Inspector';
import { AtlasView } from './viewport/AtlasView';
import { ExportDialog } from './export/ExportDialog';
import type { ActiveMap } from './state/store';

const MAP_TABS: ActiveMap[] = [
  'baseColor', 'normal', 'height', 'roughness', 'metallic', 'ao', 'wearMask', 'rectId', 'pieceId',
];

function tabLabel(k: ActiveMap): string {
  if (k === 'rectId') return es.mapBar.rectId;
  if (k === 'pieceId') return es.mapBar.pieceId;
  if (k === 'wearMask') return es.mapBar.wearMask;
  return es.material.mapKinds[k];
}

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
      <div className="grid h-full grid-cols-[240px_1fr_280px] grid-rows-[30px_1fr_28px]">
        <header className="col-span-3 flex items-center gap-3 border-b border-zinc-800 bg-zinc-900 px-2">
          <span className="font-semibold text-zinc-100">{es.appName}</span>
          <span className="text-zinc-500">{es.topBar.project}</span>
          <span className="ml-auto"><ExportDialog /></span>
        </header>
        <aside className="overflow-y-auto border-r border-zinc-800 bg-zinc-900" data-testid="left-column">
          <MaterialPanel />
          <LayoutPanel />
        </aside>
        <main className="flex min-w-0 flex-col bg-zinc-950">
          <PanelTitle>{es.atlas.title}</PanelTitle>
          {atlas ? (
            <AtlasView maps={atlas.maps} layout={atlas.layout} activeMap={activeMap} issues={atlas.issues} />
          ) : (
            <div className="flex flex-1 items-center justify-center text-zinc-600">{es.atlas.empty}</div>
          )}
        </main>
        <aside className="flex flex-col border-l border-zinc-800 bg-zinc-900">
          <PanelTitle>{es.inspector.title}</PanelTitle>
          <Inspector />
        </aside>
        <footer className="col-span-3 flex items-stretch justify-between border-t border-zinc-800 bg-zinc-900">
          <Tabs value={activeMap} onValueChange={(v) => setActiveMap(v as ActiveMap)} className="h-full">
            <TabsList className="h-full">
              {MAP_TABS.map((k) => (
                <TabsTrigger key={k} value={k} disabled={!atlas}>
                  {tabLabel(k)}
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
