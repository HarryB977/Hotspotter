import { useEffect, useRef, useState } from 'react';
import { es } from '../i18n/es';
import { useProject } from '../state/store';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog';
import { FolderField, loadDir, saveDir } from '../components/FolderField';
import { projectTitle } from './projectIo';

type Pending = { kind: 'new' } | { kind: 'open'; file: File };

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function proceed(p: Pending): void {
  if (p.kind === 'new') useProject.getState().newProject();
  else void useProject.getState().openProject(p.file);
}

/** Project name in the top bar ("•" while dirty), mirrored in the window title. */
export function ProjectName() {
  const hasDoc = useProject((s) => s.doc !== null);
  const path = useProject((s) => s.projectPath);
  const dirty = useProject((s) => s.dirty);
  const opening = useProject((s) => s.opening);
  const error = useProject((s) => s.projectError);
  const name = path ? projectTitle(path.name) : es.project.untitled;
  const label = dirty ? `${name} •` : name;

  useEffect(() => {
    document.title = hasDoc ? `${label} — ${es.appName}` : es.appName;
  }, [hasDoc, label]);

  return (
    <>
      <span className="truncate text-zinc-400" data-testid="project-name">{hasDoc ? label : es.topBar.project}</span>
      {opening && <span className="text-zinc-500" data-testid="project-opening">{es.project.opening}</span>}
      {error && (
        <span className="min-w-0 truncate text-red-400" title={error} data-testid="project-error">{error}</span>
      )}
    </>
  );
}

const ITEM = 'flex w-full items-center justify-between gap-4 px-2 py-1 text-left text-zinc-200 hover:bg-zinc-800 disabled:pointer-events-none disabled:opacity-50';

/** "Archivo" menu (Nuevo, Abrir…, Guardar, Guardar como…), its shortcuts and its dialogs. */
export function FileMenu() {
  const hasProject = useProject((s) => s.doc !== null && s.material !== null);
  const dirty = useProject((s) => s.dirty);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirm, setConfirm] = useState<Pending | null>(null);
  /** Save-as dialog, with what to do once the project is saved. */
  const [saveAs, setSaveAs] = useState<{ then?: () => void } | null>(null);
  const [dir, setDir] = useState(loadDir);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /** Nuevo / Abrir: asks first when there are unsaved changes. */
  const guard = (p: Pending) => {
    if (useProject.getState().dirty) setConfirm(p);
    else proceed(p);
  };

  const openSaveAs = (then?: () => void) => {
    const path = useProject.getState().projectPath;
    setName(path ? projectTitle(path.name) : '');
    setDir(path?.dir || loadDir());
    setSaveError(null);
    setSaveAs({ then });
  };

  /** Guardar: to the current file, or through Guardar como when it has no folder yet. */
  const save = (then?: () => void) => {
    const s = useProject.getState();
    if (!s.doc || !s.material) return;
    if (!s.projectPath?.dir) {
      openSaveAs(then);
      return;
    }
    s.saveProject().then(
      () => then?.(),
      (e: unknown) => useProject.setState({ projectError: errorMessage(e) }),
    );
  };

  const runSaveAs = async () => {
    saveDir(dir);
    setBusy(true);
    setSaveError(null);
    try {
      await useProject.getState().saveProject({ dir: dir.trim(), name });
      const then = saveAs?.then;
      setSaveAs(null);
      then?.();
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // The latest handlers, for the window listeners registered once.
  const actions = useRef({ guard, save, openSaveAs });
  actions.current = { guard, save, openSaveAs };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 's' && !e.shiftKey) {
        // Works while typing: the field commits on blur, so the save includes what was typed.
        e.preventDefault();
        if (isTyping(document.activeElement)) (document.activeElement as HTMLElement).blur();
        actions.current.save();
        return;
      }
      if (isTyping(e.target)) return;
      if (key === 's' && e.shiftKey) {
        e.preventDefault();
        if (useProject.getState().doc) actions.current.openSaveAs();
      } else if (key === 'n' && !e.shiftKey) {
        e.preventDefault();
        actions.current.guard({ kind: 'new' });
      } else if (key === 'o' && !e.shiftKey) {
        e.preventDefault();
        inputRef.current?.click();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older browsers ask only when returnValue is set.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const item = (label: string, shortcut: string, testId: string, run: () => void, disabled = false) => (
    <button
      type="button"
      role="menuitem"
      className={ITEM}
      disabled={disabled}
      data-testid={testId}
      onClick={() => {
        setMenuOpen(false);
        run();
      }}
    >
      <span>{label}</span>
      <span className="text-zinc-500">{shortcut}</span>
    </button>
  );

  return (
    <div className="relative" ref={menuRef}>
      <Button
        variant="ghost"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-testid="file-menu"
        onClick={() => setMenuOpen((o) => !o)}
      >
        {es.project.menu}
      </Button>
      {menuOpen && (
        <div
          role="menu"
          className="absolute left-0 top-full z-40 mt-1 w-56 rounded border border-zinc-700 bg-zinc-900 py-1 text-xs shadow-lg"
        >
          {item(es.project.new, 'Ctrl+N', 'file-new', () => guard({ kind: 'new' }))}
          {item(es.project.open, 'Ctrl+O', 'file-open', () => inputRef.current?.click())}
          {item(es.project.save, 'Ctrl+S', 'file-save', () => save(), !hasProject)}
          {item(es.project.saveAs, 'Ctrl+Shift+S', 'file-save-as', () => openSaveAs(), !hasProject)}
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".hsp"
        className="hidden"
        data-testid="project-open-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared so picking the same file again opens it again.
          e.target.value = '';
          if (file) guard({ kind: 'open', file });
        }}
      />

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent data-testid="unsaved-dialog">
          <DialogTitle className="mb-1 text-sm font-semibold">{es.project.unsavedTitle}</DialogTitle>
          <DialogDescription className="mb-3 text-xs text-zinc-400">{es.project.unsavedBody}</DialogDescription>
          <div className="flex justify-end gap-2">
            <Button
              variant="default"
              data-testid="unsaved-save"
              onClick={() => {
                const p = confirm!;
                setConfirm(null);
                save(() => proceed(p));
              }}
            >
              {es.project.unsavedSave}
            </Button>
            <Button
              data-testid="unsaved-discard"
              onClick={() => {
                const p = confirm!;
                setConfirm(null);
                proceed(p);
              }}
            >
              {es.project.unsavedDiscard}
            </Button>
            <Button variant="ghost" data-testid="unsaved-cancel" onClick={() => setConfirm(null)}>
              {es.project.unsavedCancel}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={saveAs !== null} onOpenChange={(o) => !o && !busy && setSaveAs(null)}>
        <DialogContent aria-describedby={undefined} data-testid="save-as-dialog">
          <DialogTitle className="mb-2 text-sm font-semibold">{es.project.saveAsTitle}</DialogTitle>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void runSaveAs();
            }}
          >
            <FolderField label={es.project.folder} value={dir} onChange={setDir} testId="save-as-dir" />
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              {es.project.name}
              <Input
                data-testid="save-as-name"
                value={name}
                placeholder={es.project.namePlaceholder}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {saveError && <div className="text-xs text-red-400" data-testid="save-as-error">{saveError}</div>}
            <Button
              type="submit"
              variant="default"
              disabled={busy || dir.trim() === '' || name.trim() === ''}
              data-testid="save-as-run"
            >
              {busy ? es.project.saving : es.project.saveRun}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
