import { es } from '../i18n/es';
import { Input } from './ui/input';

/** One folder is remembered for the export and for projects. */
const DIR_KEY = 'hotspotter.exportDir';

/** The last folder used, or ''. */
export function loadDir(): string {
  try {
    return localStorage.getItem(DIR_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveDir(dir: string): void {
  try {
    localStorage.setItem(DIR_KEY, dir);
  } catch {
    // Storage unavailable: the folder is simply not remembered.
  }
}

/** Absolute destination folder typed by the user (the local server writes there). */
export function FolderField({ label, value, onChange, testId }: {
  label: string;
  value: string;
  onChange: (dir: string) => void;
  testId: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      {label}
      <Input
        data-testid={testId}
        value={value}
        placeholder={es.export.folderPlaceholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
