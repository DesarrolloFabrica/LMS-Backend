import { Logger, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const logger = new Logger("Bootstrap");
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const corsOrigin = config.getOrThrow<string>("CORS_ORIGIN");
  const allowedOrigins = corsOrigin.split(",").map((origin) => origin.trim());

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
  await app.listen(port, "0.0.0.0");
  logger.log(`Carga LMS backend running on port ${port}`);
  logger.log(`CORS enabled for ${allowedOrigins.length} origin(s)`);
}

bootstrap().catch((error) => {
  const logger = new Logger("Bootstrap");
  logger.error("Carga LMS backend failed to start", error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
