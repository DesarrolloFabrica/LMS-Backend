import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OAuth2Client } from "google-auth-library";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  webViewLink?: string;
  webContentLink?: string;
};

type OAuthClientSecretFile = {
  web?: {
    client_id?: string;
    client_secret?: string;
  };
  installed?: {
    client_id?: string;
    client_secret?: string;
  };
};

export type DriveTransferFile = {
  id: string;
  name: string;
  path: string[];
  mimeType: string;
  size?: number;
};

export type DriveCopiedFile = {
  driveFileId: string;
  driveUrl: string;
  fileName: string;
  filePath: string[];
  sizeBytes?: number;
  mimeType?: string;
};

export type DriveDownload = {
  filename: string;
  mimeType: string;
  stream: Readable;
  size?: number;
};

@Injectable()
export class DriveService {
  private readonly logger = new Logger(DriveService.name);
  private readonly auth: OAuth2Client;
  private readonly destinationRootFolderId: string;

  constructor(config: ConfigService) {
    const clientId = config.getOrThrow<string>("drive.operatorClientId");
    const clientSecret = this.resolveClientSecret(
      config.getOrThrow<string>("drive.operatorClientSecret"),
      clientId,
    );
    this.auth = new OAuth2Client({
      clientId,
      clientSecret,
    });
    this.auth.setCredentials({
      refresh_token: config.getOrThrow<string>("drive.operatorRefreshToken"),
    });
    this.destinationRootFolderId = config.getOrThrow<string>("drive.destinationRootFolderId");
  }

  async listFilesFromFolderUrl(folderUrl: string) {
    const folderId = this.extractFolderId(folderUrl);
    const files: DriveTransferFile[] = [];

    await this.walkFolder(folderId, [], files);
    return files;
  }

  async createDestinationFolder(folderName: string) {
    const folder = await this.createFolder(this.destinationRootFolderId, folderName);
    return {
      id: folder.id,
      url: folder.webViewLink ?? this.driveFileUrl(folder.id),
    };
  }

  async copyFilesToFolder(
    files: DriveTransferFile[],
    targetFolderId: string,
    options: {
      onFileStarted?: (file: { filename: string; size?: number }, index: number) => void;
      onFileProgress?: (transferredBytes: number) => void;
      onFileCompleted?: (transferredBytes: number) => void;
    } = {},
  ) {
    let transferredBytes = 0;
    const copiedFiles: DriveCopiedFile[] = [];

    for (const [index, file] of files.entries()) {
      const parentId = await this.ensureFolderPath(targetFolderId, file.path);
      const filename = file.name;
      options.onFileStarted?.({ filename, size: file.size }, index);
      this.logger.log(`Drive copy started: ${index + 1}/${files.length} filename="${filename}" sizeBytes=${file.size ?? "unknown"}`);

      const copied = await this.copyFile(file.id, parentId, filename);
      transferredBytes += file.size ?? 0;
      options.onFileProgress?.(transferredBytes);
      copiedFiles.push({
        driveFileId: copied.id,
        driveUrl: copied.webViewLink ?? this.driveFileUrl(copied.id),
        fileName: copied.name ?? filename,
        filePath: file.path,
        sizeBytes: copied.size ? Number(copied.size) : file.size,
        mimeType: copied.mimeType ?? file.mimeType,
      });
      options.onFileCompleted?.(transferredBytes);
      this.logger.log(`Drive copy completed: ${index + 1}/${files.length} filename="${filename}"`);
    }

    return copiedFiles;
  }

  async downloadById(file: { driveFileId?: string | null; fileName: string; mimeType?: string | null; sizeBytes?: number | null }): Promise<DriveDownload> {
    if (!file.driveFileId) {
      throw new Error("Transferred file does not have a destination Drive file ID");
    }

    const driveFile: DriveTransferFile = {
      id: file.driveFileId,
      name: file.fileName,
      path: [],
      mimeType: file.mimeType ?? "application/octet-stream",
      size: file.sizeBytes ?? undefined,
    };
    const exportTarget = this.exportTarget(driveFile);
    const url = exportTarget
      ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.driveFileId)}/export?mimeType=${encodeURIComponent(exportTarget.mimeType)}`
      : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.driveFileId)}?alt=media&supportsAllDrives=true`;

    const response = await fetch(url, {
      headers: await this.authHeaders(),
    });

    if (!response.ok || !response.body) {
      throw new Error(`Drive download failed for fileId=${file.driveFileId} status=${response.status}`);
    }

    const filename = this.resolveDownloadFilename(driveFile);
    const responseSize = Number(response.headers.get("content-length"));
    const size = driveFile.size ?? (Number.isNaN(responseSize) ? undefined : responseSize);

    return {
      filename,
      mimeType: exportTarget?.mimeType ?? driveFile.mimeType,
      stream: Readable.fromWeb(response.body as never),
      size,
    };
  }

  resolveDownloadFilename(file: DriveTransferFile) {
    const exportTarget = this.exportTarget(file);
    return exportTarget ? this.withExtension(file.name, exportTarget.extension) : file.name;
  }

  samePath(left: string[], right: string[]) {
    return left.length === right.length && left.every((part, index) => part === right[index]);
  }

  private async walkFolder(folderId: string, path: string[], output: DriveTransferFile[]) {
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed=false`,
        fields: "nextPageToken,files(id,name,mimeType,size)",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      if (pageToken) params.set("pageToken", pageToken);

      const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
        headers: await this.authHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Drive list failed for folderId=${folderId} status=${response.status}`);
      }

      const payload = (await response.json()) as { nextPageToken?: string; files?: DriveFile[] };
      for (const file of payload.files ?? []) {
        if (file.mimeType === DRIVE_FOLDER_MIME) {
          await this.walkFolder(file.id, [...path, file.name], output);
          continue;
        }

        output.push({
          id: file.id,
          name: file.name,
          path,
          mimeType: file.mimeType,
          size: file.size ? Number(file.size) : undefined,
        });
      }

      pageToken = payload.nextPageToken;
    } while (pageToken);
  }

  private async ensureFolderPath(rootFolderId: string, path: string[]) {
    let currentFolderId = rootFolderId;
    for (const folderName of path) {
      currentFolderId = (await this.findOrCreateFolder(currentFolderId, folderName)).id;
    }
    return currentFolderId;
  }

  private async findOrCreateFolder(parentFolderId: string, folderName: string) {
    const existing = await this.findChildFolder(parentFolderId, folderName);
    return existing ?? this.createFolder(parentFolderId, folderName);
  }

  private async findChildFolder(parentFolderId: string, folderName: string) {
    const params = new URLSearchParams({
      q: `'${parentFolderId}' in parents and mimeType='${DRIVE_FOLDER_MIME}' and name='${this.escapeDriveQuery(folderName)}' and trashed=false`,
      fields: "files(id,name,mimeType,webViewLink)",
      pageSize: "1",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
      headers: await this.authHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Drive folder lookup failed for parentId=${parentFolderId} status=${response.status}`);
    }

    const payload = (await response.json()) as { files?: DriveFile[] };
    return payload.files?.[0] ?? null;
  }

  private async createFolder(parentFolderId: string, folderName: string) {
    const response = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name,mimeType,webViewLink", {
      method: "POST",
      headers: {
        ...(await this.authHeaders()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: folderName,
        mimeType: DRIVE_FOLDER_MIME,
        parents: [parentFolderId],
      }),
    });

    if (!response.ok) {
      throw new Error(`Drive folder creation failed for parentId=${parentFolderId} status=${response.status}`);
    }

    return (await response.json()) as DriveFile;
  }

  private async copyFile(fileId: string, parentFolderId: string, filename: string) {
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/copy?supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,webContentLink`,
      {
        method: "POST",
        headers: {
          ...(await this.authHeaders()),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: filename,
          parents: [parentFolderId],
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Drive copy failed for fileId=${fileId} status=${response.status}`);
    }

    return (await response.json()) as DriveFile;
  }

  private async authHeaders() {
    const { token } = await this.auth.getAccessToken();
    if (!token) {
      throw new Error("Google Drive access token could not be resolved");
    }

    return { Authorization: `Bearer ${token}` };
  }

  private extractFolderId(url: string) {
    const patterns = [/\/folders\/([a-zA-Z0-9_-]+)/, /[?&]id=([a-zA-Z0-9_-]+)/];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match?.[1]) return match[1];
    }

    throw new Error("Drive URL must be a folder URL");
  }

  private exportTarget(file: DriveTransferFile) {
    const targets: Record<string, { mimeType: string; extension: string }> = {
      "application/vnd.google-apps.document": { mimeType: "application/pdf", extension: ".pdf" },
      "application/vnd.google-apps.spreadsheet": {
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        extension: ".xlsx",
      },
      "application/vnd.google-apps.presentation": {
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        extension: ".pptx",
      },
      "application/vnd.google-apps.drawing": { mimeType: "image/png", extension: ".png" },
    };

    return targets[file.mimeType];
  }

  private withExtension(filename: string, extension: string) {
    return filename.toLowerCase().endsWith(extension) ? filename : `${filename}${extension}`;
  }

  private driveFileUrl(fileId: string) {
    return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
  }

  private escapeDriveQuery(value: string) {
    return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }

  private resolveClientSecret(rawSecret: string, expectedClientId: string) {
    const value = rawSecret.trim();
    if (!value) {
      throw new Error("GOOGLE_DRIVE_OPERATOR_CLIENT_SECRET cannot be empty");
    }

    if (value.startsWith("{")) {
      return this.clientSecretFromJson(value, expectedClientId);
    }

    const resolvedPath = resolve(process.cwd(), value);
    if (existsSync(resolvedPath)) {
      return this.clientSecretFromJson(readFileSync(resolvedPath, "utf8"), expectedClientId);
    }

    return value;
  }

  private clientSecretFromJson(rawJson: string, expectedClientId: string) {
    const parsed = JSON.parse(rawJson) as OAuthClientSecretFile;
    const credentials = parsed.web ?? parsed.installed;
    if (!credentials?.client_secret) {
      throw new Error("Google OAuth client secret JSON must include web.client_secret or installed.client_secret");
    }
    if (credentials.client_id && credentials.client_id !== expectedClientId) {
      throw new Error("Google OAuth client secret JSON does not match GOOGLE_DRIVE_OPERATOR_CLIENT_ID");
    }

    return credentials.client_secret;
  }
}
