/**
 * TestController — endpoints temporales de diagnóstico.
 *
 * ⚠️  SOLO PARA DESARROLLO LOCAL.
 * Este controller NO tiene guard de autenticación deliberadamente:
 * sirve para validar integraciones (Drive, Mega, etc.) sin necesitar token.
 *
 * Antes de desplegar a producción, eliminar este controller o protegerlo.
 */

import { Controller, Get, Logger, HttpCode, HttpStatus, Param, Post } from "@nestjs/common";
import {
  DriveFileInfo,
  DriveRecursiveListItem,
  GoogleDriveImportService,
} from "@/integrations/google-drive/google-drive-import.service";
import { DriveToMegaService, DriveToMegaSyncSummary } from "@/integrations/drive-to-mega/drive-to-mega.service";
import { MegaConnectionTestResult, MegaService } from "@/integrations/mega/mega.service";

interface DriveTestResponse {
  ok: boolean;
  folderId: string;
  totalItems: number;
  items: DriveFileInfo[];
}

interface DriveRecursiveTestResponse {
  ok: boolean;
  folderId: string;
  totalItems: number;
  items: DriveRecursiveListItem[];
}

interface DriveDownloadProbeResponse {
  ok: boolean;
  fileId: string;
  fileName: string;
  mimeType: string;
  size: number;
}

@Controller("test")
export class TestController {
  private readonly logger = new Logger(TestController.name);

  constructor(
    private readonly driveService: GoogleDriveImportService,
    private readonly megaService: MegaService,
    private readonly driveToMegaService: DriveToMegaService,
  ) {}

  /**
   * POST /test/sync-drive-to-mega/:folderId
   *
   * Ejecuta sincronización técnica Drive → Mega dentro de `{MEGA_BASE_PATH}/DriveSyncTest-{timestamp}`.
   */
  @Post("sync-drive-to-mega/:folderId")
  @HttpCode(HttpStatus.OK)
  async testSyncDriveToMega(@Param("folderId") folderId: string): Promise<DriveToMegaSyncSummary> {
    return this.driveToMegaService.syncDriveFolderToMega(folderId);
  }

  /**
   * GET /test/mega
   *
   * Solo autenticación y lectura de raíz Cloud Drive; no crea rutas ni sube ficheros.
   */
  @Get("mega")
  @HttpCode(HttpStatus.OK)
  async testMega(): Promise<MegaConnectionTestResult> {
    return this.megaService.testConnection();
  }

  /**
   * GET /test/drive-download/:fileId
   *
   * Ejecuta descarga real (Buffer en servidor) pero la respuesta HTTP solo lleva metadatos;
   * no expone bytes en JSON ni en body crudo aquí — útil para comprobar permisos y OpenSSL PEM.
   */
  @Get("drive-download/:fileId")
  @HttpCode(HttpStatus.OK)
  async testDriveDownload(@Param("fileId") fileId: string): Promise<DriveDownloadProbeResponse> {
    const dl = await this.driveService.downloadFile(fileId);
    const fromMeta = dl.driveReportedSize !== undefined ? Number(dl.driveReportedSize) : NaN;
    const size =
      dl.driveReportedSize !== undefined && Number.isFinite(fromMeta)
        ? fromMeta
        : dl.buffer.length;

    this.logger.log(
      `[Drive:test-download] listo id=${fileId} archivo="${dl.fileName}" tamaño_respuesta=${size} mimeSalida=${dl.mimeType}`,
    );

    return {
      ok: true,
      fileId,
      fileName: dl.fileName,
      mimeType: dl.mimeType,
      size,
    };
  }

  /**
   * GET /test/drive-recursive/:folderId
   *
   * Lista RECURSIVA (solo metadatos, lista plana) bajo esa carpeta; no descarga contenido.
   * Útil para validar tamaño/composición antes de importFolder.
   */
  @Get("drive-recursive/:folderId")
  @HttpCode(HttpStatus.OK)
  async testDriveRecursive(@Param("folderId") folderId: string): Promise<DriveRecursiveTestResponse> {
    const items = await this.driveService.listFolderRecursive(folderId);

    return {
      ok: true,
      folderId,
      totalItems: items.length,
      items,
    };
  }

  /**
   * GET /test/drive/:folderId
   *
   * Valida la conexión con Google Drive listando el primer nivel de la carpeta.
   * Acepta el ID puro de la carpeta (no el link completo).
   *
   * Respuestas posibles:
   *  200 — Conexión OK, devuelve la lista de archivos/subcarpetas.
   *  400 — El ID corresponde a un archivo, no a una carpeta.
   *  403 — La Service Account no tiene permiso sobre la carpeta.
   *  404 — Carpeta no encontrada o inaccesible.
   *  500 — Credenciales faltantes en .env u otro error de la API de Drive.
   *
   * Ejemplo:
   *  GET /test/drive/1A2B3C4D5E6F7G8H9I0J
   */
  @Get("drive/:folderId")
  @HttpCode(HttpStatus.OK)
  async testDrive(@Param("folderId") folderId: string): Promise<DriveTestResponse> {
    const items = await this.driveService.testListFolder(folderId);

    return {
      ok: true,
      folderId,
      totalItems: items.length,
      items,
    };
  }
}
