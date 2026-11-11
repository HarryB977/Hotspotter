import { useEffect } from 'react';
import { es } from './i18n/es';
import { useProject } from './state/store';
import { MaterialPanel } from './panels/MaterialPanel';
import { TooltipProvider } from './components/ui/tooltip';
import { Tabs, TabsList, TabsTrigger } from './components/ui/tabs';
import type { MapKind } from '@hotspotter/core';

const MAP_TABS: MapKind[] = ['baseColor', 'normal', 'height', 'roughness', 'metallic', 'ao'];

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
  const material = useProject((s) => s.material);

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
        </header>
        <aside className="overflow-y-auto border-r border-zinc-800 bg-zinc-900" data-testid="left-column">
          <MaterialPanel />
        </aside>
        <main className="flex min-w-0 flex-col bg-zinc-950">
          <PanelTitle>{es.atlas.title}</PanelTitle>
          <div className="flex flex-1 items-center justify-center text-zinc-600">{es.atlas.empty}</div>
        </main>
        <aside className="flex flex-col border-l border-zinc-800 bg-zinc-900">
          <PanelTitle>{es.inspector.title}</PanelTitle>
          <div className="p-2 text-zinc-600">{es.inspector.empty}</div>
        </aside>
        <footer className="col-span-3 flex items-stretch justify-between border-t border-zinc-800 bg-zinc-900">
          <Tabs defaultValue="baseColor" className="h-full">
            <TabsList className="h-full">
              {MAP_TABS.map((k) => (
                <TabsTrigger key={k} value={k} disabled={!material}>
                  {es.material.mapKinds[k]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <span className="flex items-center px-2 text-zinc-500" data-testid="gpu-info">
            {gpu ? gpu.adapterInfo : ''}
          </span>
        </footer>
      </div>
    </TooltipProvider>
  );
}
