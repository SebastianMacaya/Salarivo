try {
  const { loadConfig } = await import("./config.ts");
  const config = loadConfig();
  const { migrate } = await import("@salarivo/database");
  await migrate();
  const { buildApp } = await import("./app.ts");
  const app = await buildApp(config);
  await app.listen({ host: config.host, port: config.port });
} catch {
  process.stderr.write("API startup failed.\n");
  process.exitCode = 1;
}
