import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JWT } from "google-auth-library";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

type DriveServiceAccount = {
  client_email: string;
  private_key: string;
};

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
};

export type DriveTransferFile = {
  id: string;
  name: string;
  path: string[];
  mimeType: string;
  size?: number;
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
  private readonly auth: JWT;

  constructor(config: ConfigService) {
    const serviceAccount = this.parseServiceAccount(config.getOrThrow<string>("drive.serviceAccountJson"));
    this.auth = new JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
  }

  async listFilesFromFolderUrl(folderUrl: string) {
    const folderId = this.extractFolderId(folderUrl);
    const files: DriveTransferFile[] = [];

    await this.walkFolder(folderId, [], files);
    return files;
  }

  async download(file: DriveTransferFile): Promise<DriveDownload> {
    const exportTarget = this.exportTarget(file);
    const url = exportTarget
      ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(exportTarget.mimeType)}`
      : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`;

    const response = await fetch(url, {
      headers: await this.authHeaders(),
    });

    if (!response.ok || !response.body) {
      throw new Error(`Drive download failed for fileId=${file.id} status=${response.status}`);
    }

    const filename = this.resolveDownloadFilename(file);
    const responseSize = Number(response.headers.get("content-length"));
    const size = file.size ?? (Number.isNaN(responseSize) ? undefined : responseSize);

    return {
      filename,
      mimeType: exportTarget?.mimeType ?? file.mimeType,
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

  private async authHeaders() {
    const { access_token: accessToken } = await this.auth.authorize();
    if (!accessToken) {
      throw new Error("Google Drive access token could not be resolved");
    }

    return { Authorization: `Bearer ${accessToken}` };
  }

  private extractFolderId(url: string) {
    const patterns = [/\/folders\/([a-zA-Z0-9_-]+)/, /[?&]id=([a-zA-Z0-9_-]+)/];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match?.[1]) return match[1];
    }

    throw new Error("Drive URL must be a folder URL");
  }

  private parseServiceAccount(raw: string): DriveServiceAccount {
    const value = raw.trim();
    const json = value.startsWith("{") ? value : this.readServiceAccountFile(value);
    const parsed = JSON.parse(json) as Partial<DriveServiceAccount>;
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error("GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON must include client_email and private_key");
    }

    return {
      client_email: parsed.client_email,
      private_key: parsed.private_key.replace(/\\n/g, "\n"),
    };
  }

  private readServiceAccountFile(filePath: string) {
    const resolvedPath = resolve(process.cwd(), filePath);
    if (!existsSync(resolvedPath)) {
      throw new Error("GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON must be valid JSON or a readable local JSON file path");
    }

    return readFileSync(resolvedPath, "utf8");
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

    const target = targets[file.mimeType];
    if (!target && file.mimeType.startsWith("application/vnd.google-apps.")) {
      this.logger.warn(`Skipping unsupported Google Workspace file export: fileId=${file.id} mimeType=${file.mimeType}`);
    }
    return target;
  }

  private withExtension(filename: string, extension: string) {
    return filename.toLowerCase().endsWith(extension) ? filename : `${filename}${extension}`;
  }
}
