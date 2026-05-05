import { Module } from "@nestjs/common";
import { GoogleDriveImportModule } from "@/integrations/google-drive/google-drive-import.module";
import { TestController } from "./test.controller";

/**
 * TestModule — solo para validación local de integraciones externas.
 * Importa GoogleDriveImportModule para reutilizar el servicio sin duplicarlo.
 */
@Module({
  imports: [GoogleDriveImportModule],
  controllers: [TestController],
})
export class TestModule {}
