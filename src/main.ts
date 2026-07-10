import '@fontsource/nunito/latin-700.css';
import * as THREE from 'three';
import { Game } from './Game';
import './styles.css';

const root = document.querySelector<HTMLDivElement>('#app');

if (!root) throw new Error('Tickerworld could not find its app root.');

function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

if (!supportsWebGL()) {
  root.innerHTML = `
    <main class="unsupported-screen">
      <div class="unsupported-card">
        <span aria-hidden="true">🦊</span>
        <h1>This little world needs WebGL</h1>
        <p>Try opening Tickerworld in a recent version of Chrome, Edge, Firefox, or Safari.</p>
      </div>
    </main>`;
} else {
  THREE.ColorManagement.enabled = true;
  new Game(root);
}
