import '@fontsource/nunito/latin-700.css';
import * as THREE from 'three';
import { Game } from './Game';
import {
  BrowserMarketRouteHistory,
  type MarketChooserRoute,
  type MarketRouteModel,
} from './routing';
import { LAUNCH_CAPTURE_MODE } from './config';
import './styles.css';
import { initializeObservability } from './telemetry';

initializeObservability();
document.documentElement.classList.toggle('is-launch-capture', LAUNCH_CAPTURE_MODE);

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('Tickerworld could not find its app root.');
const appRoot = root;
const isAdminRoute = /^\/admin\/?$/i.test(location.pathname);

function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

const routeHistory = new BrowserMarketRouteHistory();
let game: Game | null = null;

function renderWebGLFailure(titleText: string, messageText: string, retry = false): void {
  document.title = `${titleText} · Tickerworld`;
  appRoot.replaceChildren();
  const screen = document.createElement('main');
  screen.className = 'unsupported-screen';
  const card = document.createElement('div');
  card.className = 'unsupported-card';
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '🦊';
  const heading = document.createElement('h1');
  heading.textContent = titleText;
  const copy = document.createElement('p');
  copy.textContent = messageText;
  card.append(icon, heading, copy);
  if (retry) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Retry Tickerworld';
    button.addEventListener('click', () => location.reload(), { once: true });
    card.append(button);
  }
  screen.append(card);
  appRoot.append(screen);
}

function renderUnsupported(): void {
  renderWebGLFailure(
    'This little world needs WebGL',
    'Try opening Tickerworld in a recent version of Chrome, Edge, Firefox, or Safari.',
  );
}

function renderChooser(route: MarketChooserRoute): void {
  document.title = `${route.title} · Tickerworld`;
  game?.dispose();
  game = null;
  appRoot.replaceChildren();
  const screen = document.createElement('main');
  screen.className = 'market-chooser-screen';
  const card = document.createElement('section');
  card.className = 'market-chooser-card';
  const kicker = document.createElement('div');
  kicker.className = 'market-chooser-kicker';
  kicker.textContent = 'A quiet path back';
  const heading = document.createElement('h1');
  heading.textContent = route.title;
  const message = document.createElement('p');
  message.textContent = route.message;
  const choices = document.createElement('nav');
  choices.setAttribute('aria-label', 'Live market worlds');
  choices.className = 'market-chooser-grid';
  for (const choice of route.choices) {
    const link = document.createElement('a');
    link.href = choice.path;
    link.textContent = choice.symbol;
    link.setAttribute('aria-label', choice.label);
    choices.append(link);
  }
  card.append(kicker, heading, message, choices);
  screen.append(card);
  appRoot.append(screen);
}

function mountRoute(route: MarketRouteModel): void {
  if (route.kind === 'chooser') {
    renderChooser(route);
    return;
  }
  if (!supportsWebGL()) {
    game?.dispose();
    game = null;
    renderUnsupported();
    return;
  }
  document.body.dataset.captureMarket = route.market;
  THREE.ColorManagement.enabled = true;
  if (!game) {
    try {
      game = new Game(appRoot, { activeMarket: route.market, routeHistory });
    } catch {
      game = null;
      renderWebGLFailure(
        'The world could not grow',
        'Your route is safe. Close another graphics-heavy tab, then try Tickerworld again.',
        true,
      );
    }
    return;
  }
  if (game.marketSymbol !== route.market) void game.switchMarket(route.market);
}

if (isAdminRoute) {
  void import('./admin/AdminApp').then(({ AdminApp }) => {
    const admin = new AdminApp(appRoot);
    addEventListener('beforeunload', () => admin.dispose(), { once: true });
  });
} else {
  mountRoute(routeHistory.canonicalize());
  routeHistory.subscribe(mountRoute);
}
addEventListener('beforeunload', () => routeHistory.dispose(), { once: true });
