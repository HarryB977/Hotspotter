import { fileURLToPath } from 'node:url';
import { buildApp } from './app';

const port = Number(process.env.HOTSPOTTER_PORT ?? 7420);
const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));

const app = buildApp({ webRoot });
app.listen({ host: '127.0.0.1', port }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
