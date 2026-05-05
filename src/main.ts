import { Logger, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

let megajsUnhandledRejectionGuardInstalled = false;

function installMegajsUnhandledRejectionGuard() {
  if (megajsUnhandledRejectionGuardInstalled) return;
  megajsUnhandledRejectionGuardInstalled = true;

  const log = new Logger("MegajsGuard");
  process.on("unhandledRejection", (reason: unknown) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (!msg.toLowerCase().includes("api is closed")) return;
    log.warn(`Rechazo tardío ignorado (${msg}); suele venir tras un cierre de sesión muy pronto tras subidas.`);
  });
}

async function bootstrap() {
  installMegajsUnhandledRejectionGuard();

  const logger = new Logger("Bootstrap");
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const corsOrigin = config.get<string>("CORS_ORIGIN") ?? "http://localhost:3000";
  const allowedOrigins = corsOrigin
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  app.setGlobalPrefix("api");
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = config.getOrThrow<number>("port");
  await app.listen(port);
  logger.log(`Carga LMS backend running on port ${port}`);
  logger.log(`CORS enabled for ${allowedOrigins.length} origin(s)`);
}

void bootstrap();
