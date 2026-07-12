export type ShareCompletionMode = 'native' | 'clipboard' | 'download' | 'cancelled' | 'failed';

export interface ShareCompletion {
  readonly mode: ShareCompletionMode;
  readonly completed: boolean;
  /** Present for fallbacks that separately attempt to copy a URL. */
  readonly linkCopied?: boolean;
}

export interface ShareNavigatorLike {
  readonly clipboard?: { writeText(text: string): Promise<void> };
  share?(data: ShareData): Promise<void>;
  canShare?(data: ShareData): boolean;
}

export interface ShareLinkOptions {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly navigator?: ShareNavigatorLike;
}

function wasCancelled(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError');
}

export async function shareOrCopyLink(options: ShareLinkOptions): Promise<ShareCompletion> {
  const target = options.navigator ?? navigator;
  if (typeof target.share === 'function') {
    try {
      await target.share({ title: options.title, text: options.text, url: options.url });
      return { mode: 'native', completed: true };
    } catch (error) {
      if (wasCancelled(error)) return { mode: 'cancelled', completed: false };
    }
  }
  try {
    await target.clipboard?.writeText(options.url);
    return target.clipboard
      ? { mode: 'clipboard', completed: true }
      : { mode: 'failed', completed: false };
  } catch {
    return { mode: 'failed', completed: false };
  }
}

export interface SharePostcardOptions extends ShareLinkOptions {
  readonly png: Blob;
  readonly filename: string;
  readonly createFile?: (blob: Blob, filename: string) => File;
  readonly download?: (blob: Blob, filename: string) => void;
}

export async function sharePostcard(options: SharePostcardOptions): Promise<ShareCompletion> {
  const target = options.navigator ?? navigator;
  const createFile = options.createFile ?? ((blob, filename) => new File([blob], filename, { type: 'image/png' }));
  let nativeData: ShareData | null = null;
  try {
    const file = createFile(options.png, options.filename);
    nativeData = { title: options.title, text: options.text, url: options.url, files: [file] };
  } catch {
    // Older browsers without File still receive the download fallback below.
  }
  let canShareFiles = false;
  try {
    canShareFiles = Boolean(nativeData && target.canShare?.(nativeData));
  } catch {
    canShareFiles = false;
  }
  if (nativeData && typeof target.share === 'function' && canShareFiles) {
    try {
      await target.share(nativeData);
      return { mode: 'native', completed: true };
    } catch (error) {
      if (wasCancelled(error)) return { mode: 'cancelled', completed: false };
    }
  }

  const download = options.download ?? downloadBlob;
  download(options.png, options.filename);
  let linkCopied = false;
  try {
    if (target.clipboard) {
      await target.clipboard.writeText(options.url);
      linkCopied = true;
    }
  } catch {
    // The image is still safely downloaded when clipboard permission is denied.
  }
  return { mode: 'download', completed: true, linkCopied };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.click();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
}
