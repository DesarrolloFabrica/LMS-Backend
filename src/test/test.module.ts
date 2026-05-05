import { Module } from "@nestjs/common";
import { DriveToMegaModule } from "@/integrations/drive-to-mega/drive-to-mega.module";
import { GoogleDriveImportModule } from "@/integrations/google-drive/google-drive-import.module";
import { MegaModule } from "@/integrations/mega/mega.module";
import { TestController } from "./test.controller";

/**
 * TestModule — solo para validación local de integraciones externas.
 */
@Module({
  imports: [GoogleDriveImportModule, MegaModule, DriveToMegaModule],
  controllers: [TestController],
})
export class TestModule {}