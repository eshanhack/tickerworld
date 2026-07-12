import { ANIMAL_KINDS, type AnimalKind } from '../../shared/src/index.js';

export interface WardrobeEntry {
  readonly animal: AnimalKind;
  readonly label: string;
  readonly sigil: string;
}

const LABELS: Readonly<Record<AnimalKind, string>> = {
  fox: 'Fox',
  penguin: 'Penguin',
  frog: 'Frog',
  duck: 'Duck',
  bear: 'Bear',
  rabbit: 'Rabbit',
  cat: 'Cat',
  axolotl: 'Axolotl',
};

const SIGILS: Readonly<Record<AnimalKind, string>> = {
  fox: 'FX',
  penguin: 'PG',
  frog: 'FR',
  duck: 'DK',
  bear: 'BR',
  rabbit: 'RB',
  cat: 'CT',
  axolotl: 'AX',
};

export function baseWardrobeEntries(): readonly WardrobeEntry[] {
  return ANIMAL_KINDS.map((animal) => ({
    animal,
    label: LABELS[animal],
    sigil: SIGILS[animal],
  }));
}

export interface WardrobeViewOptions {
  readonly selected: AnimalKind;
  readonly onSelect: (animal: AnimalKind) => void;
  readonly onClose: () => void;
}

export class WardrobeView {
  public readonly element: HTMLElement;
  private readonly options: WardrobeViewOptions;
  private readonly buttons = new Map<AnimalKind, HTMLButtonElement>();
  private selected: AnimalKind;

  public constructor(parent: HTMLElement, options: WardrobeViewOptions) {
    this.options = options;
    this.selected = options.selected;
    this.element = document.createElement('section');
    this.element.className = 'wardrobe-panel is-hidden';
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-labelledby', 'wardrobe-title');

    const close = document.createElement('button');
    close.className = 'wardrobe-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Close creature wardrobe');
    close.textContent = '\u00d7';
    close.addEventListener('click', options.onClose);

    const kicker = document.createElement('div');
    kicker.className = 'wardrobe-kicker';
    kicker.textContent = 'Your world form';
    const title = document.createElement('h2');
    title.id = 'wardrobe-title';
    title.textContent = 'Choose your creature';
    const copy = document.createElement('p');
    copy.textContent = 'All eight launch creatures are free. Switch whenever the mood changes.';
    const grid = document.createElement('div');
    grid.className = 'wardrobe-grid';

    for (const entry of baseWardrobeEntries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.animal = entry.animal;
      button.className = `wardrobe-animal wardrobe-${entry.animal}`;
      button.innerHTML = `<span aria-hidden="true">${entry.sigil}</span><strong>${entry.label}</strong><small>Free</small>`;
      button.addEventListener('click', () => {
        this.setSelected(entry.animal);
        this.options.onSelect(entry.animal);
      });
      grid.append(button);
      this.buttons.set(entry.animal, button);
    }

    this.element.append(close, kicker, title, copy, grid);
    parent.append(this.element);
    this.setSelected(this.selected);
  }

  public setOpen(open: boolean): void {
    this.element.classList.toggle('is-hidden', !open);
    this.element.setAttribute('aria-hidden', String(!open));
  }

  public setSelected(animal: AnimalKind): void {
    this.selected = animal;
    for (const [kind, button] of this.buttons) {
      const selected = kind === animal;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
  }

  public dispose(): void {
    this.element.remove();
  }
}
