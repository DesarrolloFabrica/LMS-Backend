import { Module } from "@nestjs/common";
import { DriveService } from "@/transfers/drive.service";
import { MegaService } from "@/transfers/mega.service";
import { TransferProgressService } from "@/transfers/transfer-progress.service";
import { TransferService } from "@/transfers/transfer.service";

@Module({
  providers: [DriveService, MegaService, TransferService, TransferProgressService],
  exports: [DriveService, TransferService, TransferProgressService],
})
export class TransfersModule {}
