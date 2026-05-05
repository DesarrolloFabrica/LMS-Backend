/**
 * TestController — endpoints temporales de diagnóstico.
 *
 * ⚠️  SOLO PARA DESARROLLO LOCAL.
 * Este controller NO tiene guard de autenticación deliberadamente:
 * sirve para validar integraciones (Drive, Mega, etc.) sin necesitar token.
 *
 * Antes de desplegar a producción, eliminar este controller o protegerlo.
 */

import { Controller, Get, Param, HttpCode, HttpStatus } from "@nestjs/common";
import { GoogleDriveImportService, DriveFileInfo } from "@/integrations/google-drive/google-drive-import.service";

interface DriveTestResponse {
  ok: boolean;
  folderId: string;
  totalItems: number;
  items: DriveFileInfo[];
}

@Controller("test")
export class TestController {
  constructor(private readonly driveService: GoogleDriveImportService) {}

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
