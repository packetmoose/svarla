import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { bootstrap } from './bootstrap.js';
import { createDatabase } from './database.js';
import { StartupCleanupService } from './services/startup-cleanup-service.js';
import { ApkProvisioningService } from './services/apk-provisioning-service.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // Run migrations and set initial password if needed
  await bootstrap(config.databaseUrl);

  // Run startup cleanup after migrations but before accepting connections.
  // This reconciles stale call history entries and pending notifications
  // that may have been left in an inconsistent state by a previous crash.
  const cleanupDb = createDatabase(config);
  const startupCleanupService = new StartupCleanupService({
    db: cleanupDb,
    logger: console,
  });
  try {
    await startupCleanupService.run();
  } catch (error) {
    console.error('[StartupCleanup] Fatal: Startup cleanup failed, aborting server start', error);
    await cleanupDb.destroy();
    process.exit(1);
  }
  await cleanupDb.destroy();

  const server = await buildServer(config);

  // Provision APK for the download endpoint (non-blocking — server starts regardless)
  const pkg = await import('../package.json', { assert: { type: 'json' } });
  const apkConfig = ApkProvisioningService.loadConfig(pkg.default.version);
  const apkService = new ApkProvisioningService(apkConfig, server.log);
  apkService.provision().then((available) => {
    if (available) {
      server.log.info('[APK] Download endpoint ready');
    } else {
      server.log.info('[APK] No APK available — download page will show unavailable');
    }
  }).catch((err) => {
    server.log.warn(err, '[APK] Provisioning failed');
  });

  try {
    await server.listen({ port: config.port, host: config.host });
    server.log.info(`Server listening on ${config.host}:${config.port}`);
  } catch (error) {
    server.log.fatal(error, 'Failed to start server');
    process.exit(1);
  }

  // Graceful shutdown on signals
  const shutdown = async (signal: string) => {
    server.log.info(`Received ${signal}, shutting down...`);
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
