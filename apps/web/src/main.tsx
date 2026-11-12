import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

if (import.meta.env.DEV) {
  void import('./test-harness/engineHarness').then((m) => m.installHarness());
}

createRoot(document.getElementById('root')!).render(<App />);
