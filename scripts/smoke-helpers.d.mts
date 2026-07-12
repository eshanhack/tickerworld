export interface JpegDimensions {
  width: number;
  height: number;
}

export function jpegDimensions(buffer: ArrayBuffer | ArrayBufferView): JpegDimensions | null;
export function pngDimensions(buffer: ArrayBuffer | ArrayBufferView): JpegDimensions | null;
export function imageDimensions(buffer: ArrayBuffer | ArrayBufferView): JpegDimensions | null;
