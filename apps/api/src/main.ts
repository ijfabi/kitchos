import { loadConfig } from './config.ts';
import { createApp } from './create-app.ts';

const config = loadConfig();
const { app, logger } = await createApp(config);
await app.listen(config.API_PORT);
logger.info({ port: config.API_PORT }, 'KitchOS API listening');
