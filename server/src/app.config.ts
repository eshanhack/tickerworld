import { createServerApp } from './app.js';
import { loadConfig } from './config.js';
import { createRuntime } from './runtime.js';

export const runtime = await createRuntime(loadConfig());
const app = createServerApp(runtime);

export default app;
