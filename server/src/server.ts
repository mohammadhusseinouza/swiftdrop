import "./config/load-env";
import { createApp } from "./app";
import { prisma } from "./db/prisma";

const PORT = Number(process.env.PORT) || 3000;

const app = createApp();

const server = app.listen(PORT, () => {
  console.log(`[server] listening on port ${PORT} (${process.env.NODE_ENV ?? "development"})`);
});

function shutdown(signal: string): void {
  console.log(`[server] received ${signal}, shutting down`);
  server.close(() => {
    prisma.$disconnect().finally(() => process.exit(0));
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
