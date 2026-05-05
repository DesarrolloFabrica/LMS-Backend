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

/**
 * Ítem devuelto por listFolderRecursive: lista plana (no árbol), sin descargas.
 * Solo metadatos obtenidos con files.list / recursión.
 */
export interface DriveRecursiveListItem {
  id: string;
  name: string;
  mimeType: string;
  /** Bytes si Drive incluye size (muchas superficies omiten tamaño para carpetas o Google Docs nativos). */
  size?: string;
  /** Ruta bajo la raíz de esta operación (p. ej. "/Videos/clase1.mp4"). */
  path: string;
  /** ID del folder Drive que contenía este ítem en el listado donde apareció. */
  parentFolderId: string;
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

/**
 * Binary materializado tras descarga o export desde Drive API v3.
 * El contenido llega como Buffer (internamente suele obtenerse como stream `alt=media` o `files.export`).
 */
export interface DriveFileDownloadResult {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  /**
   * `files.get(..., fields: size)` cuando Drive lo proporciona para el recurso binario tal cual está almacenado.
   * Tras una exportación de Google Workspace suele estar ausente; usar `buffer.length` como tamaño efectivo.
   */
  driveReportedSize?: string;
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

  /**
   * Lista de forma RECURSIVA todos los archivos y subcarpetas bajo {@link folderId},
   * solo metadatos (sin `alt=media`). El resultado es una lista plana: primero pueden
   * aparecer carpetas y luego hijos conforme la recursión avanza por profundidad.
   *
   * @param folderId — ID Drive de la carpeta raíz a inspeccionar.
   * @param currentPath — Prefijo para las rutas lógicas. Dejar vacío para que los hijos directos usen `/nombre`;
   *   valores no vacíos siguen convención con barra inicial (p. ej. si se reusara tras un nivel).
   */
  async listFolderRecursive(folderId: string, currentPath = ""): Promise<DriveRecursiveListItem[]> {
    this.logger.log(
      `[Drive:listRecursive] Inicio folderId=${folderId}, prefijo PATH="${currentPath === "" ? "(raíz)" : currentPath}"`,
    );

    const drive = this.buildDriveClient();
    await this.assertIsFolder(drive, folderId);

    const flat: DriveRecursiveListItem[] = [];
    await this.accumulateRecursiveList(drive, folderId, currentPath.trim(), flat);

    this.logger.log(`[Drive:listRecursive] Total ítems en lista plana: ${flat.length}`);
    return flat;
  }

  /**
   * Descarga por ID un archivo desde Drive API v3.
   *
   * - Archivos binarios típicos: stream con `files.get(..., alt: 'media')` → Buffer en memoria.
   * - Google Docs / Sheets / Slides / Drawings exportables: método `files.export` con formato de salida fijo (PDF, XLSX, PNG según aplique).
   * - Carpetas: rechazadas con HTTP 400.
   *
   * No escribe disco ni Mega; sólo devuelve un objeto con campo `buffer` en memoria.
   */
  async downloadFile(fileId: string): Promise<DriveFileDownloadResult> {
    const drive = this.buildDriveClient();
    this.logger.log(`[Drive:download] Solicitud metadata id=${fileId}`);

    let meta: drive_v3.Schema$File;
    try {
      const res = await drive.files.get({
        fileId,
        fields: "id, name, mimeType, size",
      });
      meta = res.data;
    } catch (error: unknown) {
      this.raiseDriveFileLookupError(error, fileId);
    }

    const fileName = meta.name ?? "download";
    const nativeMime = meta.mimeType ?? "application/octet-stream";

    if (nativeMime === DRIVE_FOLDER_MIME) {
      this.logger.warn(`[Drive:download] Intentó descargar carpeta como archivo id=${fileId}`);
      throw new BadRequestException(
        `El recurso "${fileId}" es una carpeta en Drive. Usa la id de un archivo (PDF, vídeo, etc.).`,
      );
    }

    const driveReportedSize =
      meta.size !== undefined && meta.size !== null && `${meta.size}`.trim() !== "" ? String(meta.size) : undefined;

    let buffer: Buffer;
    let outputFileName = fileName;
    let outputMimeType = nativeMime;

    if (nativeMime.startsWith("application/vnd.google-apps.")) {
      const exportPlan = this.googleAppsExportPlan(nativeMime, fileName);
      if (!exportPlan) {
        this.logger.warn(`[Drive:download] Google Apps sin soporte export id=${fileId} mime=${nativeMime}`);
        throw new BadRequestException(
          `El tipo "${nativeMime}" no tiene export configurado desde el backend (fileId="${fileId}").`,
        );
      }

      outputFileName = exportPlan.fileName;
      outputMimeType = exportPlan.exportMimeType;

      this.logger.log(
        `[Drive:download] Workspace export id=${fileId} desde=${nativeMime} hacia=${exportPlan.exportMimeType}`,
      );

      try {
        const exportRes = await drive.files.export(
          { fileId, mimeType: exportPlan.exportMimeType },
          { responseType: "stream" },
        );
        buffer = await streamToBuffer(exportRes.data as Readable);
      } catch (error: unknown) {
        this.logger.error(`[Drive:download] Export fallido id=${fileId}: ${String(error)}`);
        throw new InternalServerErrorException(`No se pudo exportar desde Google Workspace (id=${fileId}).`);
      }
    } else {
      this.logger.log(`[Drive:download] Binario alt=media id=${fileId} mime=${nativeMime}`);
      buffer = await this.fetchBinaryMediaAsBuffer(drive, fileId);
    }

    this.logger.log(
      `[Drive:download] Completo id=${fileId} nombre="${outputFileName}" mimeSalida=${outputMimeType} bytesRecibidos=${buffer.length}`,
    );

    return {
      fileName: outputFileName,
      mimeType: outputMimeType,
      buffer,
      ...(driveReportedSize !== undefined ? { driveReportedSize } : {}),
    };
  }

  /**
   * Extrae `folderId` desde el enlace público/id puro para flujos que no llaman {@link importFolder}.
   */
  getFolderIdFromUrlOrThrow(driveUrl: string): string {
    const folderId = this.extractFolderId(driveUrl.trim());
    if (!folderId) {
      this.logger.warn(`[Drive] Enlace sin folderId reconocible (prefijo): ${driveUrl.slice(0, 96)}`);
      throw new BadRequestException(
        "El enlace de Google Drive no contiene un identificador de carpeta válido. Usa un link de carpeta o el ID de la carpeta.",
      );
    }
    return folderId;
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

    const hasEmail = Boolean(email?.trim());
    const hasPrivateKeyEnv = Boolean(rawKey?.trim());
    this.logger.log(
      `[Drive:auth] GOOGLE_SERVICE_ACCOUNT_EMAIL definida: ${hasEmail}; GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY definida: ${hasPrivateKeyEnv}`,
    );

    if (!email || !rawKey) {
      throw new InternalServerErrorException(
        "Faltan variables de entorno GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.",
      );
    }

    const privateKey = this.normalizeGoogleServiceAccountPrivateKey(rawKey);
    this.logger.log(
      `[Drive:auth] privateKey empieza con -----BEGIN PRIVATE KEY-----: ${privateKey.startsWith("-----BEGIN PRIVATE KEY-----")}; ` +
        `termina con -----END PRIVATE KEY-----: ${privateKey.endsWith("-----END PRIVATE KEY-----")}; ` +
        `longitud: ${privateKey.length}`,
    );

    const auth = new google.auth.GoogleAuth({
      credentials: { client_email: email, private_key: privateKey },
      // Si se impersona un usuario de G-Suite se necesita domain-wide delegation
      ...(impersonatedUser ? { clientOptions: { subject: impersonatedUser } } : {}),
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });

    return google.drive({ version: "v3", auth });
  }

  /**
   * Normaliza GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY para los casos habituales del .env:
   *  - trim inicial
   *  - quita comillas envolventes (`"…"`)
   *  - quita coma final (valor copiado de un JSON sin cerrar)
   *  - convierte \n literales a saltos de línea reales (PEM válido)
   *  - trim final
   *
   * Lanza InternalServerErrorException si el PEM resultante no tiene las
   * cabeceras esperadas, para dar un mensaje claro en lugar del críptico
   * error:1E08010C:DECODER routines::unsupported de OpenSSL.
   */
  private normalizeGoogleServiceAccountPrivateKey(rawPrivateKey: string): string {
    const pem = rawPrivateKey
      .trim()
      .replace(/^"|"$/g, "")
      .replace(/,$/, "")
      .replace(/\\n/g, "\n")
      .trim();

    if (!pem.startsWith("-----BEGIN PRIVATE KEY-----") || !pem.includes("-----END PRIVATE KEY-----")) {
      this.logger.error(
        "[Drive:auth] GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY no tiene formato PEM válido " +
          `(empieza con -----BEGIN PRIVATE KEY-----: ${pem.startsWith("-----BEGIN PRIVATE KEY-----")}, ` +
          `incluye -----END PRIVATE KEY-----: ${pem.includes("-----END PRIVATE KEY-----")}, ` +
          `longitud: ${pem.length})`,
      );
      throw new InternalServerErrorException(
        "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY no tiene formato PEM válido. " +
          "Asegúrate de que la clave en .env empieza con -----BEGIN PRIVATE KEY----- " +
          "y termina con -----END PRIVATE KEY-----, con saltos de línea como \\n literales.",
      );
    }

    return pem;
  }

  /**
   * Ruta visible en la respuesta: hijos directos del folder raíz llevan "/" + nombre.
   */
  private buildLogicalDrivePath(prefix: string, segmentName: string): string {
    const trimmedPrefix = prefix.trim();
    if (trimmedPrefix === "") return `/${segmentName}`;
    const base = trimmedPrefix.startsWith("/") ? trimmedPrefix : `/${trimmedPrefix}`;
    return `${base}/${segmentName}`;
  }

  /**
   * Lista los hijos inmediatos de una carpeta, empuja metadatos a {@link out} y si un hijo es
   * carpeta, se llama a sí mismo. Usa paginación `nextPageToken` para no omitir grandes carpetas.
   */
  private async accumulateRecursiveList(
    drive: drive_v3.Drive,
    parentFolderDriveId: string,
    logicalPathPrefix: string,
    out: DriveRecursiveListItem[],
  ): Promise<void> {
    let pageToken: string | undefined;

    do {
      this.logger.debug(`[Drive:listRecursive] Carpeta Drive ${parentFolderDriveId} (prefijo="${logicalPathPrefix || "/"}")`);

      const res = await drive.files.list({
        q: `'${parentFolderDriveId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, size)",
        pageSize: 1000,
        pageToken,
      });

      const items = res.data.files ?? [];
      pageToken = res.data.nextPageToken ?? undefined;

      for (const item of items) {
        if (!item.id) continue;

        const name = item.name ?? "(sin nombre)";
        const mimeType = item.mimeType ?? "application/octet-stream";
        const isFolder = mimeType === DRIVE_FOLDER_MIME;
        const path = this.buildLogicalDrivePath(logicalPathPrefix, name);

        const row: DriveRecursiveListItem = {
          id: item.id,
          name,
          mimeType,
          path,
          parentFolderId: parentFolderDriveId,
          isFolder,
        };

        if (item.size != null && `${item.size}`.trim() !== "") {
          row.size = String(item.size);
        }

        out.push(row);

        if (isFolder) {
          await this.accumulateRecursiveList(drive, item.id, path, out);
        }
      }
    } while (pageToken);
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

  /** Descarga un binario cargado como tal en Drive mediante `files.get` + alt=media. */
  private async fetchBinaryMediaAsBuffer(drive: drive_v3.Drive, fileId: string): Promise<Buffer> {
    try {
      const res = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "stream" },
      );
      return await streamToBuffer(res.data as Readable);
    } catch (error: unknown) {
      this.logger.error(`[Drive:download] Error alt=media id=${fileId}: ${String(error)}`);
      throw new InternalServerErrorException(`Error descargando binario desde Drive (id=${fileId}).`);
    }
  }

  /**
   * Errores de `files.get` al resolver metadatos o permisos antes de una descarga.
   */
  private raiseDriveFileLookupError(error: unknown, fileId: string): never {
    if (error instanceof BadRequestException) throw error;
    if (error instanceof NotFoundException) throw error;

    const gaxiosError = error as { code?: number; message?: string };
    const httpCode = gaxiosError.code;

    if (httpCode === 404) {
      this.logger.error(`[Drive:download] Metadata 404 id=${fileId}`);
      throw new NotFoundException(
        `Archivo "${fileId}" no existe en Drive o la cuenta de servicio no tiene visibilidad sobre él.`,
      );
    }

    if (httpCode === 403) {
      this.logger.error(`[Drive:download] Metadata 403 id=${fileId}`);
      throw new ForbiddenException(
        `Sin permiso de lectura para "${fileId}". Comparte el elemento con ${this.config.get<string>("googleDrive.serviceAccountEmail")}.`,
      );
    }

    this.logger.error(`[Drive:download] Metadata inesperada id=${fileId}: ${String(error)}`);
    throw new InternalServerErrorException(
      `Fallo consultando archivo en Drive: ${gaxiosError.message ?? String(error)}`,
    );
  }

  /**
   * Mime de export y nombre sugeridos para algunos artefactos de Google Workspace
   * (solo los que tienen formato de salida estable en Drive v3).
   */
  private googleAppsExportPlan(nativeMime: string, displayName: string): {
    exportMimeType: string;
    fileName: string;
  } | null {
    const base = displayName.replace(/\.[^/.]+$/, "");
    switch (nativeMime) {
      case "application/vnd.google-apps.document":
        return { exportMimeType: "application/pdf", fileName: `${base}.pdf` };
      case "application/vnd.google-apps.spreadsheet":
        return {
          exportMimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          fileName: `${base}.xlsx`,
        };
      case "application/vnd.google-apps.presentation":
        return { exportMimeType: "application/pdf", fileName: `${base}.pdf` };
      case "application/vnd.google-apps.drawing":
        return { exportMimeType: "image/png", fileName: `${base}.png` };
      default:
        return null;
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
          const buffer = await this.fetchBinaryMediaAsBuffer(drive, item.id);
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
