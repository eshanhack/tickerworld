import {
  ANIMAL_KINDS,
  normalizeUsername,
  type AnimalKind,
  type SkinId,
} from '../../shared/src/index.js';

export interface WardrobeEntry {
  readonly animal: AnimalKind;
  readonly skin: SkinId;
  readonly label: string;
  readonly sigil: string;
  readonly primary: string;
  readonly secondary: string;
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

const BASE_LOOKS: Readonly<Record<AnimalKind, Omit<WardrobeEntry, 'animal' | 'skin' | 'label'>>> = {
  fox: { sigil: 'FX', primary: '#c9795c', secondary: '#ffe7c0' },
  penguin: { sigil: 'PG', primary: '#526a78', secondary: '#fff1cf' },
  frog: { sigil: 'FR', primary: '#79ad79', secondary: '#e7efbd' },
  duck: { sigil: 'DK', primary: '#e2b95f', secondary: '#ffedb1' },
  bear: { sigil: 'BR', primary: '#9b765e', secondary: '#e9cfa9' },
  rabbit: { sigil: 'RB', primary: '#c0a5c8', secondary: '#f5e5ed' },
  cat: { sigil: 'CT', primary: '#b88671', secondary: '#f4d7bd' },
  axolotl: { sigil: 'AX', primary: '#d99aa8', secondary: '#f5ced5' },
};

export function baseWardrobeEntries(): readonly WardrobeEntry[] {
  return ANIMAL_KINDS.map((animal) => ({
    animal,
    skin: 'base',
    label: LABELS[animal],
    ...BASE_LOOKS[animal],
  }));
}

export function colorWardrobeEntries(): readonly WardrobeEntry[] {
  // Kept as a compatibility export for callers compiled against the previous
  // wardrobe API. Color charms are no longer a selectable character layer.
  return [];
}

export function freeWardrobeEntries(): readonly WardrobeEntry[] {
  return baseWardrobeEntries();
}

export function normalizeWardrobeUsername(value: string): string | null {
  return normalizeUsername(value);
}

export interface WardrobeViewOptions {
  readonly selectedAnimal: AnimalKind;
  readonly selectedSkin: SkinId;
  readonly username: string | null;
  readonly onSelect: (animal: AnimalKind, skin: SkinId) => boolean | void;
  readonly onUsernameChange: (username: string | null) => boolean | void;
  readonly onClose: () => void;
}

function appearanceKey(animal: AnimalKind, skin: SkinId): string {
  return `${animal}:${skin}`;
}

export class WardrobeView {
  public readonly element: HTMLElement;
  private readonly options: WardrobeViewOptions;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly nameInput: HTMLInputElement;
  private readonly nameStatus: HTMLElement;
  private selectedAnimal: AnimalKind;
  private selectedSkin: SkinId;

  public constructor(parent: HTMLElement, options: WardrobeViewOptions) {
    this.options = options;
    this.selectedAnimal = options.selectedAnimal;
    this.selectedSkin = options.selectedSkin;
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
    title.textContent = 'Make this wanderer yours';
    const copy = document.createElement('p');
    copy.textContent = 'Choose a creature with its own size, movement, jumps, and personality.';

    const nameForm = document.createElement('form');
    nameForm.className = 'wardrobe-name-form';
    nameForm.noValidate = true;
    const nameLabel = document.createElement('label');
    nameLabel.htmlFor = 'wardrobe-display-name';
    nameLabel.textContent = 'Display name';
    this.nameInput = document.createElement('input');
    this.nameInput.id = 'wardrobe-display-name';
    this.nameInput.name = 'display-name';
    this.nameInput.type = 'text';
    this.nameInput.setAttribute('autocomplete', 'nickname');
    this.nameInput.maxLength = 16;
    this.nameInput.minLength = 3;
    this.nameInput.pattern = '[A-Za-z0-9_]{3,16}';
    this.nameInput.placeholder = 'Magic_Fox';
    this.nameInput.spellcheck = false;
    this.nameInput.value = options.username ?? '';
    const saveName = document.createElement('button');
    saveName.type = 'submit';
    saveName.textContent = 'Save name';
    const clearName = document.createElement('button');
    clearName.type = 'button';
    clearName.className = 'wardrobe-name-clear';
    clearName.textContent = 'Clear';
    clearName.addEventListener('click', this.clearUsername);
    this.nameStatus = document.createElement('small');
    this.nameStatus.className = 'wardrobe-name-status';
    this.nameStatus.id = 'wardrobe-name-status';
    this.nameStatus.textContent = '3\u201316 letters, numbers, or _. Names are unique in each room.';
    this.nameInput.setAttribute('aria-describedby', this.nameStatus.id);
    nameForm.addEventListener('submit', this.submitUsername);
    nameForm.append(nameLabel, this.nameInput, saveName, clearName, this.nameStatus);

    const baseSection = this.createLookSection('Creatures', baseWardrobeEntries(), 'Classic');
    this.element.append(close, kicker, title, copy, nameForm, baseSection);
    parent.append(this.element);
    this.setSelected(this.selectedAnimal, this.selectedSkin);
  }

  public setOpen(open: boolean): void {
    this.element.classList.toggle('is-hidden', !open);
    this.element.setAttribute('aria-hidden', String(!open));
  }

  public setSelected(animal: AnimalKind, _skin: SkinId): void {
    this.selectedAnimal = animal;
    // Old persisted skin ids remain legal protocol values, but the wardrobe
    // now has one canonical look per species.
    this.selectedSkin = 'base';
    const selectedKey = appearanceKey(animal, 'base');
    for (const [key, button] of this.buttons) {
      const selected = key === selectedKey;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
  }

  public setUsername(username: string | null): void {
    this.nameInput.value = username ?? '';
    this.nameInput.setAttribute('aria-invalid', 'false');
  }

  public dispose(): void {
    this.nameInput.form?.removeEventListener('submit', this.submitUsername);
    this.element.remove();
  }

  private createLookSection(
    headingText: string,
    entries: readonly WardrobeEntry[],
    badge: string,
  ): HTMLElement {
    const section = document.createElement('section');
    section.className = 'wardrobe-look-section';
    const heading = document.createElement('h3');
    heading.textContent = headingText;
    const grid = document.createElement('div');
    grid.className = 'wardrobe-grid';
    for (const entry of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.animal = entry.animal;
      button.dataset.skin = entry.skin;
      button.className = `wardrobe-animal wardrobe-${entry.animal}`;
      button.style.setProperty('--wardrobe-primary', entry.primary);
      button.style.setProperty('--wardrobe-secondary', entry.secondary);
      button.setAttribute('aria-label', `Use ${entry.label}`);
      const sigil = document.createElement('span');
      sigil.setAttribute('aria-hidden', 'true');
      sigil.textContent = entry.sigil;
      const label = document.createElement('strong');
      label.textContent = entry.label;
      const small = document.createElement('small');
      small.textContent = badge;
      button.append(sigil, label, small);
      button.addEventListener('click', () => {
        if (this.options.onSelect(entry.animal, entry.skin) === false) return;
        this.setSelected(entry.animal, entry.skin);
      });
      grid.append(button);
      this.buttons.set(appearanceKey(entry.animal, entry.skin), button);
    }
    section.append(heading, grid);
    return section;
  }

  private readonly submitUsername = (event: SubmitEvent): void => {
    event.preventDefault();
    const requested = this.nameInput.value.trim();
    const username = requested ? normalizeWardrobeUsername(requested) : null;
    if (requested && !username) {
      this.nameInput.setAttribute('aria-invalid', 'true');
      this.nameStatus.textContent = 'Use 3\u201316 letters, numbers, or underscores only.';
      return;
    }
    if (this.options.onUsernameChange(username) === false) return;
    this.nameInput.value = username ?? '';
    this.nameInput.setAttribute('aria-invalid', 'false');
    this.nameStatus.textContent = username
      ? `${username} is saved in this browser. If a room already uses it, choose another.`
      : 'Display name cleared. You will appear as your creature.';
  };

  private readonly clearUsername = (): void => {
    if (this.options.onUsernameChange(null) === false) return;
    this.nameInput.value = '';
    this.nameInput.setAttribute('aria-invalid', 'false');
    this.nameStatus.textContent = 'Display name cleared. You will appear as your creature.';
  };
}
