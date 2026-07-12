export interface JpegDimensions {
  width: number;
  height: number;
}

export function jpegDimensions(buffer: ArrayBuffer | ArrayBufferView): JpegDimensions | null;
