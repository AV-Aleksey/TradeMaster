// IDE hosts can export this flag for their own Electron runtime. It must not
// make our desktop process run as a headless Node process.
delete process.env.ELECTRON_RUN_AS_NODE;
const { createServer, preview } = await import('electron-vite');
try {
  if (process.argv[2] === 'dev') await createServer({}, {});
  else await preview({}, { skipBuild: true });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Не удалось запустить приложение');
  process.exitCode = 1;
}
