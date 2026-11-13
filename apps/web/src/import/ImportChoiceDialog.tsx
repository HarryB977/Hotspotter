import { es } from '../i18n/es';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog';

/** Asks whether new files extend the loaded material or replace it. Esc or close cancels. */
export function ImportChoiceDialog({ open, onChoose, onCancel }: {
  open: boolean;
  onChoose(mode: 'add' | 'replace'): void;
  onCancel(): void;
}) {
  const t = es.material.importChoice;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent>
        <DialogTitle className="mb-1 text-sm">{t.title}</DialogTitle>
        <DialogDescription className="mb-3 text-zinc-400">{t.description}</DialogDescription>
        <div className="flex justify-end gap-2">
          <Button size="sm" data-testid="import-replace" onClick={() => onChoose('replace')}>{t.replace}</Button>
          <Button size="sm" data-testid="import-add" onClick={() => onChoose('add')}>{t.add}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
