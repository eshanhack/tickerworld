import type { AssetSymbol } from '../types';
import type { PortalDwellSnapshot } from './PortalDwellController';
import './portal.css';

export class PortalOverlayView {
  public readonly root: HTMLDivElement;

  private readonly label: HTMLDivElement;
  private readonly progressFill: HTMLSpanElement;
  private disposed = false;

  public constructor(parent: HTMLElement, documentRef: Document = document) {
    this.root = documentRef.createElement('div');
    this.root.className = 'tickerworld-portal-overlay';
    this.root.dataset.visible = 'false';
    this.root.dataset.loading = 'false';
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    this.root.setAttribute('aria-atomic', 'true');

    const card = documentRef.createElement('div');
    card.className = 'tickerworld-portal-card';
    this.label = documentRef.createElement('div');
    const progress = documentRef.createElement('div');
    progress.className = 'tickerworld-portal-progress';
    this.progressFill = documentRef.createElement('span');
    progress.append(this.progressFill);
    card.append(this.label, progress);
    this.root.append(card);
    parent.append(this.root);
  }

  public setDwell(snapshot: PortalDwellSnapshot): void {
    if (this.disposed || this.root.dataset.loading === 'true') return;
    const route = snapshot.route;
    if (!route || snapshot.phase !== 'dwelling') {
      this.hide();
      return;
    }
    this.root.dataset.visible = 'true';
    this.label.textContent = `Hold still for ${Math.max(0, snapshot.remainingSeconds).toFixed(1)}s · ${route.destination}`;
    this.root.style.setProperty('--portal-progress', snapshot.progress.toFixed(4));
  }

  public showLoading(destination: AssetSymbol): void {
    if (this.disposed) return;
    this.root.dataset.loading = 'true';
    this.root.dataset.visible = 'true';
    this.label.textContent = `Travelling to ${destination}…`;
    this.root.style.setProperty('--portal-progress', '1');
  }

  public hideLoading(): void {
    if (this.disposed) return;
    this.root.dataset.loading = 'false';
    this.hide();
  }

  public hide(): void {
    if (this.disposed) return;
    this.root.dataset.visible = 'false';
    this.root.style.setProperty('--portal-progress', '0');
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.remove();
  }
}
