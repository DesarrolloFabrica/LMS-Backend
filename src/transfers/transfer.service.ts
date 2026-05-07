import { Injectable, Logger } from "@nestjs/common";
import { DriveService } from "@/transfers/drive.service";
import { MegaService } from "@/transfers/mega.service";
import { TransferProgressService } from "@/transfers/transfer-progress.service";

@Injectable()
export class TransferService {
  private readonly logger = new Logger(TransferService.name);

  constructor(
    private readonly driveService: DriveService,
    private readonly megaService: MegaService,
    private readonly progressService: TransferProgressService,
  ) {}

  async copyDriveFolderToMega(input: { driveFolderUrl: string; subjectId: number; subjectName: string; transferId?: string }) {
    if (input.transferId) this.progressService.start(input.transferId);
    const files = await this.driveService.listFilesFromFolderUrl(input.driveFolderUrl);
    if (files.length === 0) {
      throw new Error(`Drive folder has no transferable files: subjectId=${input.subjectId}`);
    }
    const totalBytes = files.reduce((sum, file) => sum + (file.size ?? 0), 0);
    if (input.transferId) this.progressService.setTotal(input.transferId, files.length, totalBytes);

    this.logger.log(`Drive to MEGA transfer started: subjectId=${input.subjectId} fileCount=${files.length} totalBytes=${totalBytes}`);

    const transferFiles = files.map((file) => ({
      filename: this.driveService.resolveDownloadFilename(file),
      path: file.path,
      size: file.size,
      mimeType: file.mimeType,
      openStream: async () => {
        if (input.transferId) this.progressService.fileStarted(input.transferId, this.driveService.resolveDownloadFilename(file));
        const download = await this.driveService.download(file);
        return download.stream;
      },
    }));

    const folderName = this.folderName(input.subjectId, input.subjectName);
    const transferredFiles = await this.megaService.uploadFolder(folderName, transferFiles, {
      onFileStarted: (file) => {
        if (input.transferId) this.progressService.fileStarted(input.transferId, file.filename);
      },
      onFileProgress: (transferredBytes) => {
        if (input.transferId) this.progressService.fileProgress(input.transferId, transferredBytes);
      },
      onFileCompleted: (transferredBytes) => {
        if (input.transferId) this.progressService.fileCompleted(input.transferId, transferredBytes);
      },
    });

    this.logger.log(`Drive to MEGA transfer completed: subjectId=${input.subjectId} fileCount=${files.length}`);
    if (input.transferId) this.progressService.complete(input.transferId);
    return transferredFiles;
  }

  progress(transferId: string) {
    return this.progressService.get(transferId);
  }

  failProgress(transferId: string, error: string) {
    this.progressService.fail(transferId, error);
  }

  private folderName(subjectId: number, subjectName: string) {
    const normalizedName = subjectName
      .trim()
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
      .replace(/\s+/g, " ")
      .slice(0, 120);

    return `${subjectId} - ${normalizedName || "Materia"}`;
  }
}
