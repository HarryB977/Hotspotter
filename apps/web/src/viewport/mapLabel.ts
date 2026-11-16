import { es } from '../i18n/es';
import type { ActiveMap } from '../state/store';

/** Name of a map as the map bar shows it. */
export function mapLabel(k: ActiveMap): string {
  if (k === 'rectId') return es.mapBar.rectId;
  if (k === 'pieceId') return es.mapBar.pieceId;
  if (k === 'wearMask') return es.mapBar.wearMask;
  return es.material.mapKinds[k];
}
