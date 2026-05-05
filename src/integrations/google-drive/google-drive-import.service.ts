/**
 * GoogleDriveImportService
 *
 * Responsabilidades:
 *  1. Extraer el folderId desde cualquier formato de link de Drive.
 *  2. Validar que el recurso sea una carpeta (mimeType = folder).
 *  3. Listar de forma RECURSIVA todos los archivos y subcarpetas.
 *  4. Descargar cada archivo como Buffer en memoria.
 *  5. Devolver una lista plana de { relativePath, name, buffer }.
 *
 * Autenticación: Service Account con impersonación opcional.
 * Si GOOGLE_IMPERSONATED_USER está definido, se hace domain-wide delegation.
 * De lo contrario, la Service Account debe tener acceso directo a la carpeta.
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { google, drive_v3 } from "googleapis";
import { Readable } from "stream";

/**
 * Resultado devuelto por testListFolder: metadatos de un ítem de Drive
 * sin descargar el contenido.
 */
export interface DriveFileInfo {
  id: string;
  name: string;
  mimeType: string;
  /** true si el ítem es una subcarpeta. */
  isFolder: boolean;
}

/** Un archivo descargado de Drive listo para subir a Mega. */
export interface DriveFile {
  /** Nombre del archivo (ej: "clase1.pdf"). */
  name: string;
  /** Ruta relativa desde la carpeta raíz del Drive (ej: "modulo-1/clase1.pdf"). */
  relativePath: string;
  /** Contenido del archivo en memoria. */
  buffer: Buffer;
  /** MimeType del archivo según Drive. */
  mimeType: string;
}

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

@Injectable()
export class GoogleDriveImportService {
  private readonly logger = new Logger(GoogleDriveImportService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Punto de entrada principal.
   * Recibe el link de Drive, extrae el folderId, valida que sea carpeta,
   * recorre todo el árbol de forma recursiva y descarga cada archivo.
   *
   * @param driveUrl - Link de Google Drive (cualquier formato público o de servicio).
   * @returns Lista plana de archivos descargados con sus rutas relativas.
   */
  async importFolder(driveUrl: string): Promise<DriveFile[]> {
    // ── Paso 1: extraer el folderId ──────────────────────────────────────────
    const folderId = this.extractFolderId(driveUrl);
    if (!folderId) {
      this.logger.error(`[Drive] No se pudo extraer folderId de: ${driveUrl}`);
      throw new BadRequestException("El link de Drive no contiene un folderId válido.");
    }
    this.logger.log(`[Drive] folderId extraído: ${folderId}`);

    // ── Paso 2: construir cliente Drive con Service Account ──────────────────
    const drive = this.buildDriveClient();

    // ── Paso 3: validar que el recurso sea una carpeta ───────────────────────
    await this.assertIsFolder(drive, folderId);

    // ── Paso 4: listar y descargar de forma recursiva ────────────────────────
    const files: DriveFile[] = [];
    await this.traverseFolder(drive, folderId, "", files);

    this.logger.log(`[Drive] Total archivos descargados: ${files.length}`);
    return files;
  }

  // ── Método de diagnóstico ───────────────────────────────────────────────────

  /**
   * Lista (sin recursión ni descarga) los archivos y subcarpetas de primer nivel
   * de la carpeta cuyo ID se pasa directamente.
   *
   * Útil para validar credenciales y permisos ANTES de implementar la descarga
   * completa. Lo consume el endpoint GET /test/drive/:folderId.
   *
   * Errores distinguidos:
   *  - 500 si faltan credenciales en .env
   *  - 404 si Drive devuelve 404 (carpeta inexistente o sin acceso)
   *  - 403 si la Service Account no tiene permiso sobre la carpeta
   *  - 400 si el ID corresponde a un archivo, no a una carpeta
   *  - 500 para cualquier otro error de la API de Drive
   */
  async testListFolder(folderId: string): Promise<DriveFileInfo[]> {
    this.logger.log(`[Drive:test] Listando primer nivel de carpeta: ${folderId}`);

    // 1. Construir cliente (lanza 500 si faltan credenciales)
    const drive = this.buildDriveClient();

    // 2. Obtener metadatos de la carpeta para validar tipo y acceso
    let folderName: string;
    try {
      const meta = await drive.files.get({
        fileId: folderId,
        fields: "id, name, mimeType",
      });

      if (meta.data.mimeType !== DRIVE_FOLDER_MIME) {
        this.logger.warn(`[Drive:test] El recurso no es una carpeta: ${meta.data.mimeType}`);
        throw new BadRequestException(
          `El ID "${folderId}" corresponde a un archivo (${meta.data.mimeType}), no a una carpeta.`,
        );
      }

      folderName = meta.data.name ?? folderId;
      this.logger.log(`[Drive:test] Carpeta válida: "${folderName}"`);
    } catch (error) {
      // Re-lanzar errores de negocio ya tipados
      if (error instanceof BadRequestException) throw error;

      const gaxiosError = error as { code?: number; message?: string };
      const httpCode = gaxiosError.code;

      if (httpCode === 404) {
        this.logger.error(`[Drive:test] Carpeta no encontrada: ${folderId}`);
        throw new NotFoundException(
          `La carpeta "${folderId}" no existe en Drive o la Service Account no tiene acceso a ella.`,
        );
      }
      if (httpCode === 403) {
        this.logger.error(`[Drive:test] Permiso denegado para: ${folderId}`);
        throw new ForbiddenException(
          `La Service Account no tiene permiso para leer la carpeta "${folderId}". ` +
            `Comparte la carpeta con ${this.config.get("googleDrive.serviceAccountEmail")} al menos como Lector.`,
        );
      }

      this.logger.error(`[Drive:test] Error inesperado: ${String(error)}`);
      throw new InternalServerErrorException(
        `Error al acceder a Drive: ${gaxiosError.message ?? String(error)}`,
      );
    }

    // 3. Listar primer nivel (sin recursión)
    try {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "files(id, name, mimeType)",
        pageSize: 100, // suficiente para diagnóstico
      });

      const items = (res.data.files ?? []).map((f) => ({
        id: f.id ?? "",
        name: f.name ?? "(sin nombre)",
        mimeType: f.mimeType ?? "application/octet-stream",
        isFolder: f.mimeType === DRIVE_FOLDER_MIME,
      }));

      this.logger.log(
        `[Drive:test] "${folderName}" — ${items.length} elemento(s) encontrado(s):\n` +
          items.map((i) => `  [${i.isFolder ? "DIR" : "FILE"}] ${i.name}  (${i.mimeType})`).join("\n"),
      );

      return items;
    } catch (error) {
      this.logger.error(`[Drive:test] Error al listar archivos: ${String(error)}`);
      throw new InternalServerErrorException(`Error al listar contenido de Drive: ${String(error)}`);
    }
  }

  // ── Métodos privados ────────────────────────────────────────────────────────

  /**
   * Extrae el ID de carpeta de Google Drive desde distintos formatos de URL:
   *  - https://drive.google.com/drive/folders/{id}
   *  - https://drive.google.com/drive/folders/{id}?usp=sharing
   *  - https://drive.google.com/open?id={id}
   *  - ID puro (40 caracteres alfanuméricos)
   */
  private extractFolderId(url: string): string | null {
    // Formato /folders/{id}
    const foldersMatch = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (foldersMatch) return foldersMatch[1];

    // Formato ?id={id}
    const idParamMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (idParamMatch) return idParamMatch[1];

    // ID puro (33+ caracteres alfanuméricos/guiones)
    const pureId = url.match(/^([a-zA-Z0-9_-]{25,})$/);
    if (pureId) return pureId[1];

    return null;
  }

  /**
   * Construye el cliente de Google Drive usando la Service Account.
   * Si GOOGLE_IMPERSONATED_USER está definido, impersona ese usuario
   * (requiere domain-wide delegation en GSuite/Workspace).
   */
  private buildDriveClient(): drive_v3.Drive {
    const email = this.config.get<string>("googleDrive.serviceAccountEmail");
    const rawKey = this.config.get<string>("googleDrive.serviceAccountPrivateKey");
    const impersonatedUser = this.config.get<string>("googleDrive.impersonatedUser");

    if (!email || !rawKey) {
      throw new InternalServerErrorException(
        "Faltan variables de entorno GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.",
      );
    }

    // Las private keys llegan escapadas desde .env (\n → salto real)
    const privateKey = rawKey.replace(/\\n/g, "\n");

    const auth = new google.auth.GoogleAuth({
      credentials: { client_email: email, private_key: privateKey },
      // Si se impersona un usuario de G-Suite se necesita domain-wide delegation
      ...(impersonatedUser ? { clientOptions: { subject: impersonatedUser } } : {}),
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });

    return google.drive({ version: "v3", auth });
  }

  /**
   * Verifica que el nodo con ese ID sea una carpeta de Drive.
   * Si no lo es (es un archivo, o no existe / sin permiso) lanza error.
   */
  private async assertIsFolder(drive: drive_v3.Drive, folderId: string): Promise<void> {
    try {
      const res = await drive.files.get({
        fileId: folderId,
        fields: "id, name, mimeType",
      });
      if (res.data.mimeType !== DRIVE_FOLDER_MIME) {
        this.logger.error(`[Drive] El recurso ${folderId} no es una carpeta (mimeType: ${res.data.mimeType})`);
        throw new BadRequestException("El link de Drive apunta a un archivo, no a una carpeta.");
      }
      this.logger.log(`[Drive] Carpeta validada: "${res.data.name}" (${folderId})`);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error(`[Drive] Error al validar la carpeta ${folderId}: ${String(error)}`);
      throw new InternalServerErrorException(`No se pudo acceder a la carpeta de Drive: ${String(error)}`);
    }
  }

  /**
   * Recorre RECURSIVAMENTE la carpeta de Drive.
   * - Para cada subcarpeta encontrada, vuelve a llamarse a sí mismo.
   * - Para cada archivo, lo descarga y lo agrega a la lista `files`.
   *
   * @param drive       - Cliente Drive autenticado.
   * @param folderId    - ID de la carpeta a recorrer.
   * @param basePath    - Ruta relativa acumulada (ej: "modulo-1/").
   * @param files       - Lista acumuladora (se modifica in-place).
   */
  private async traverseFolder(
    drive: drive_v3.Drive,
    folderId: string,
    basePath: string,
    files: DriveFile[],
  ): Promise<void> {
    let pageToken: string | undefined;

    // Drive pagina los resultados; iteramos hasta agotar todas las páginas
    do {
      this.logger.debug(`[Drive] Listando carpeta ${folderId} (basePath="${basePath}")`);

      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType)",
        pageSize: 1000,
        pageToken,
      });

      const items = res.data.files ?? [];
      pageToken = res.data.nextPageToken ?? undefined;

      for (const item of items) {
        if (!item.id || !item.name) continue;

        if (item.mimeType === DRIVE_FOLDER_MIME) {
          // Es una subcarpeta → recursión
          this.logger.log(`[Drive] Subcarpeta encontrada: "${item.name}"`);
          await this.traverseFolder(drive, item.id, `${basePath}${item.name}/`, files);
        } else {
          // Es un archivo → descargar
          const buffer = await this.downloadFile(drive, item.id, item.name);
          files.push({
            name: item.name,
            relativePath: `${basePath}${item.name}`,
            buffer,
            mimeType: item.mimeType ?? "application/octet-stream",
          });
          this.logger.log(`[Drive] Archivo descargado: "${basePath}${item.name}" (${buffer.length} bytes)`);
        }
      }
    } while (pageToken);
  }

  /**
   * Descarga un archivo de Drive como Buffer.
   * Los Google Docs nativos (Docs, Sheets, Slides) se exportan en un formato
   * estándar antes de descargarse.
   */
  private async downloadFile(drive: drive_v3.Drive, fileId: string, fileName: string): Promise<Buffer> {
    try {
      const res = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "stream" },
      );

      return await streamToBuffer(res.data as Readable);
    } catch (error) {
      this.logger.error(`[Drive] Error al descargar archivo "${fileName}" (${fileId}): ${String(error)}`);
      throw new InternalServerErrorException(`Error descargando "${fileName}" desde Drive.`);
    }
  }
}

/** Convierte un Readable stream a Buffer. */
function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}
