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
    maxWidth: number;
    lineHeight: number | string;
    whiteSpace: string;
    overflowWrap: string;
    fontWeight: number | string;
    colorRanges: Record<number, number | string> | null;
    outlineWidth: number | string;
    outlineColor: number | string;
    outlineOpacity: number;
    depthOffset: number;
    sync(callback?: () => void): void;
    dispose(): void;
  }
}
