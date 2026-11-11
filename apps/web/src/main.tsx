import { createRoot } from 'react-dom/client';

if (import.meta.env.DEV) {
  void import('./test-harness/engineHarness').then((m) => m.installHarness());
}

createRoot(document.getElementById('root')!).render(<div id="app">Hotspotter</div>);
