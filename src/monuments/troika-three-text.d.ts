declare module 'troika-three-text' {
  import { Mesh } from 'three';

  export class Text extends Mesh {
    text: string;
    font?: string | null;
    fontSize: number;
    color: number | string;
    anchorX: number | string;
    anchorY: number | string;
    textAlign: string;
    outlineWidth: number | string;
    outlineColor: number | string;
    outlineOpacity: number;
    depthOffset: number;
    sync(callback?: () => void): void;
    dispose(): void;
  }
}
