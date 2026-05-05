import { Module } from "@nestjs/common";
import { GoogleDriveImportService } from "./google-drive-import.service";

@Module({
  providers: [GoogleDriveImportService],
  exports: [GoogleDriveImportService],
})
export class GoogleDriveImportModule {}
