import { Injectable } from "@nestjs/common";

export type TransferProgressStatus = "idle" | "listing" | "uploading" | "completed" | "failed";

export type TransferProgress = {
  transferId: string;
  status: TransferProgressStatus;
  totalFiles: number;
  completedFiles: number;
  totalBytes: number;
  transferredBytes: number;
  percent: number;
  currentFile?: string;
  error?: string;
  updatedAt: string;
};

@Injectable()
export class TransferProgressService {
  private readonly items = new Map<string, TransferProgress>();

  start(transferId: string) {
    this.set(transferId, {
      transferId,
      status: "listing",
      totalFiles: 0,
      completedFiles: 0,
      totalBytes: 0,
      transferredBytes: 0,
      percent: 1,
      updatedAt: new Date().toISOString(),
    });
  }

  setTotal(transferId: string, totalFiles: number, totalBytes = 0) {
    const current = this.getOrCreate(transferId);
    this.set(transferId, {
      ...current,
      status: "uploading",
      totalFiles,
      completedFiles: 0,
      totalBytes,
      transferredBytes: 0,
      percent: totalFiles > 0 ? 5 : 100,
    });
  }

  fileStarted(transferId: string, currentFile: string) {
    const current = this.getOrCreate(transferId);
    this.set(transferId, {
      ...current,
      status: "uploading",
      currentFile,
      percent: current.percent,
    });
  }

  fileProgress(transferId: string, transferredBytes: number) {
    const current = this.getOrCreate(transferId);
    const safeTransferredBytes = Math.max(current.transferredBytes, transferredBytes);
    this.set(transferId, {
      ...current,
      status: "uploading",
      transferredBytes: safeTransferredBytes,
      percent: this.percent(current.completedFiles, current.totalFiles, safeTransferredBytes, current.totalBytes),
    });
  }

  fileCompleted(transferId: string, transferredBytes?: number) {
    const current = this.getOrCreate(transferId);
    const completedFiles = Math.min(current.completedFiles + 1, current.totalFiles);
    const safeTransferredBytes = transferredBytes
      ? Math.max(current.transferredBytes, transferredBytes)
      : current.transferredBytes;
    this.set(transferId, {
      ...current,
      status: completedFiles >= current.totalFiles ? "completed" : "uploading",
      completedFiles,
      transferredBytes: safeTransferredBytes,
      percent: completedFiles >= current.totalFiles ? 100 : this.percent(completedFiles, current.totalFiles, safeTransferredBytes, current.totalBytes),
    });
  }

  complete(transferId: string) {
    const current = this.getOrCreate(transferId);
    this.set(transferId, {
      ...current,
      status: "completed",
      completedFiles: current.totalFiles,
      transferredBytes: current.totalBytes || current.transferredBytes,
      percent: 100,
    });
  }

  fail(transferId: string, error: string) {
    const current = this.getOrCreate(transferId);
    this.set(transferId, {
      ...current,
      status: "failed",
      error,
    });
  }

  get(transferId: string) {
    return this.items.get(transferId) ?? this.getOrCreate(transferId);
  }

  private getOrCreate(transferId: string) {
    const existing = this.items.get(transferId);
    if (existing) return existing;
    const next: TransferProgress = {
      transferId,
      status: "idle",
      totalFiles: 0,
      completedFiles: 0,
      totalBytes: 0,
      transferredBytes: 0,
      percent: 0,
      updatedAt: new Date().toISOString(),
    };
    this.items.set(transferId, next);
    return next;
  }

  private set(transferId: string, progress: Omit<TransferProgress, "updatedAt"> & { updatedAt?: string }) {
    const previous = this.items.get(transferId);
    const percent = progress.status === "failed"
      ? progress.percent
      : Math.max(previous?.percent ?? 0, progress.percent);

    this.items.set(transferId, {
      ...progress,
      percent,
      updatedAt: progress.updatedAt ?? new Date().toISOString(),
    });
  }

  private percent(completedFiles: number, totalFiles: number, transferredBytes = 0, totalBytes = 0) {
    if (totalBytes > 0) {
      return Math.min(99, Math.max(5, Math.round((transferredBytes / totalBytes) * 100)));
    }
    if (totalFiles <= 0) return 5;
    return Math.min(99, Math.max(5, Math.round((completedFiles / totalFiles) * 100)));
  }
}
