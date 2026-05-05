import { Module } from "@nestjs/common";
import { DriveToMegaService } from "./drive-to-mega.service";
import { GoogleDriveImportModule } from "@/integrations/google-drive/google-drive-import.module";
import { MegaModule } from "@/integrations/mega/mega.module";

@Module({
  imports: [GoogleDriveImportModule, MegaModule],
  providers: [DriveToMegaService],
  exports: [DriveToMegaService],
})
export class DriveToMegaModule {}
