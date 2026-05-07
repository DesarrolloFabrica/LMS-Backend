import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import mega = require("megajs");
import { Transform, type TransformCallback } from "node:stream";
import { Readable } from "node:stream";

type MegaFolder = mega.MutableFile;

@Injectable()
export class MegaService {
  private readonly logger = new Logger(MegaService.name);
  private readonly email: string;
  private readonly password: string;
  private readonly rootFolderName?: string;

  constructor(config: ConfigService) {
    this.email = config.getOrThrow<string>("mega.email");
    this.password = config.getOrThrow<string>("mega.password");
    this.rootFolderName = config.get<string>("mega.rootFolderName");
  }

  async uploadFolder(
    folderName: string,
    files: Array<{ filename: string; path: string[]; size?: number; mimeType?: string; openStream: () => Promise<Readable> }>,
    options: {
      onFileStarted?: (file: { filename: string; size?: number }, index: number) => void;
      onFileProgress?: (transferredBytes: number) => void;
      onFileCompleted?: (transferredBytes: number) => void;
    } = {},
  ) {
    let uploadedBytes = 0;
    const storage = await new mega.Storage({
      email: this.email,
      password: this.password,
      autoload: true,
      autologin: true,
    }).ready;

    try {
      const root = this.rootFolderName
        ? await this.withMegaRetry(() => this.ensureChildFolder(storage.root, this.rootFolderName as string), "ensure root folder")
        : storage.root;
      const targetFolder = await this.withMegaRetry(() => this.ensureChildFolder(root, folderName), "ensure target folder");
      const uploadedFiles: Array<{ fileName: string; filePath: string[]; megaUrl: string; sizeBytes?: number; mimeType?: string }> = [];

      for (const [index, file] of files.entries()) {
        const parent = await this.withMegaRetry(() => this.ensureFolderPath(targetFolder, file.path), "ensure nested folder");
        const stream = await file.openStream();
        options.onFileStarted?.({ filename: file.filename, size: file.size }, index);
        this.logger.log(`MEGA file upload started: ${index + 1}/${files.length} filename="${file.filename}" sizeBytes=${file.size ?? "unknown"}`);
        const uploadedFile = await this.withMegaRetry(
          () =>
            this.uploadFile(parent, file.filename, stream, file.size, (bytes) => {
              uploadedBytes += bytes;
              options.onFileProgress?.(uploadedBytes);
            }),
          `upload ${file.filename}`,
        );
        const megaUrl = await this.withMegaRetry<string>(() => uploadedFile.link({ noKey: false }), `link ${file.filename}`);
        uploadedFiles.push({
          fileName: file.filename,
          filePath: file.path,
          megaUrl,
          sizeBytes: file.size,
          mimeType: file.mimeType,
        });
        options.onFileCompleted?.(uploadedBytes);
        this.logger.log(`MEGA file uploaded: ${index + 1}/${files.length} filename="${file.filename}"`);
      }

      this.logger.log(`MEGA files linked: folder="${folderName}" fileCount=${files.length}`);
      return uploadedFiles;
    } finally {
      await storage.close();
    }
  }

  private async ensureFolderPath(root: MegaFolder, path: string[]) {
    let current = root;
    for (const part of path) {
      current = await this.ensureChildFolder(current, part);
    }
    return current;
  }

  private async ensureChildFolder(parent: MegaFolder, name: string) {
    const existing = parent.children?.find((child) => child.directory && child.name === name);
    if (existing) return existing;
    return parent.mkdir({ name });
  }

  private async uploadFile(parent: MegaFolder, filename: string, stream: Readable, size?: number, onProgress?: (bytes: number) => void) {
    const upload = parent.upload({ name: filename, size }) as mega.UploadStream;
    const counter = new ByteCounter((bytes) => {
      onProgress?.(bytes);
    });

    stream.pipe(counter).pipe(upload);
    return upload.complete;
  }

  private async withMegaRetry<T>(operation: () => Promise<T>, label: string, maxAttempts = 3): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!this.isTemporaryMegaError(error) || attempt === maxAttempts) break;

        const delayMs = 1_000 * attempt;
        this.logger.warn(`Temporary MEGA error during ${label}. Retrying attempt=${attempt + 1}/${maxAttempts}`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`MEGA operation failed: ${label}`);
  }

  private isTemporaryMegaError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("EAGAIN") || message.toLowerCase().includes("temporary congestion");
  }
}

class ByteCounter extends Transform {
  constructor(private readonly onChunk: (bytes: number) => void) {
    super();
  }

  override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback) {
    this.onChunk(Buffer.byteLength(chunk, encoding));
    callback(null, chunk);
  }
}
