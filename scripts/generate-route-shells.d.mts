export const MARKET_SHELLS: readonly (readonly [string, string])[];
export function renderMarketShell(template: string, slug: string, symbol: string): string;
export function renderAdminShell(template: string): string;
export function generateRouteShells(outputDirectory?: string): Promise<void>;
