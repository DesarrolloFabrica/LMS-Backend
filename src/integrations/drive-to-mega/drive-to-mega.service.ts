import { BadRequestException, HttpException, Injectable, Logger } from "@nestjs/common";

import type { DriveRecursiveListItem } from "@/integrations/google-drive/google-drive-import.service";

import { GoogleDriveImportService } from "@/integrations/google-drive/google-drive-import.service";

import type { MegaDriveSyncSandbox, MegaUploadResult } from "@/integrations/mega/mega.service";

import { MegaService } from "@/integrations/mega/mega.service";

import type { MutableFile } from "megajs";



/** Resumen POST /api/test/sync-drive-to-mega/:folderId (sandbox). */

export interface DriveToMegaSyncSummary {

  ok: true;

  totalFolders: number;

  totalFiles: number;

  uploadedFiles: number;

  failedFiles: number;

}



/**

 * Orquesta Drive → Mega para sandbox (`DriveSyncTest-…`) o para alta real de materias.

 */

@Injectable()

export class DriveToMegaService {

  private readonly logger = new Logger(DriveToMegaService.name);



  constructor(

    private readonly googleDrive: GoogleDriveImportService,

    private readonly megaService: MegaService,

  ) {}



  /**

   * Lista Drive, crea `MEGA_BASE_PATH/DriveSyncTest-{ts}`, espejo de carpetas y archivos.

   * Fallos por archivo: se registran y se continúa (solo pruebas).

   */

  async syncDriveFolderToMega(folderId: string): Promise<DriveToMegaSyncSummary> {

    this.logger.log(`[Drive→Mega][sandbox] Inicio sync folderIdDrive=${folderId}`);



    const items = await this.googleDrive.listFolderRecursive(folderId);

    const sandboxFolderName = `DriveSyncTest-${Date.now()}`;

    const session = await this.megaService.prepareDriveSyncSandbox(sandboxFolderName);



    try {

      const { uploadedFiles, failedFiles, totalFolders, totalFiles } = await this.mirrorDriveItemsIntoMegaSession(

        items,

        session,

        {

          allowPartialFileFailures: true,

          logPrefix: `[Drive→Mega][sandbox][${sandboxFolderName}]`,

        },

      );



      this.logger.log(

        `[Drive→Mega][sandbox] Resumen ${sandboxFolderName} carpetas=${totalFolders} archivos=${totalFiles} subidos=${uploadedFiles} fallidos=${failedFiles}`,

      );



      return {

        ok: true,

        totalFolders,

        totalFiles,

        uploadedFiles,

        failedFiles,

      };

    } finally {

      await this.megaService.closeMegaSessionSafely(session.storage, "drive-sync-sandbox");

    }

  }



  /**

   * Flujo producción (materias): misma lógica de espejo que el sandbox; destino es

   * `{MEGA_BASE_PATH}/{materia}` (solo un segmento adicional; `MEGA_BASE_PATH` ya define período/entorno).

   * Si falla la copia de archivos/carpetas → excepción (no persistir materia).
   * Si la copia termina pero falla solo el link público → continúa con `created_without_public_link`.

   */

  async syncDriveFolderForMateriaCreate(params: {

    driveFolderId: string;

    semester: string;

    programName: string;

    subjectName: string;

    requestId: string;

  }): Promise<MegaUploadResult> {

    const { driveFolderId, subjectName, requestId } = params;

    const rq = `[Materias][${requestId}]`;



    let session: MegaDriveSyncSandbox | undefined;



    try {

      this.logger.log(`${rq} folderId Drive extraído/validado: ${driveFolderId}`);

      this.logger.log(`${rq} Inicio listado recursivo Drive…`);



      const items = await this.googleDrive.listFolderRecursive(driveFolderId);



      this.logger.log(`${rq} Inicio sync Drive→Mega — un segmento bajo MEGA_BASE_PATH: materia="${subjectName.trim()}"`);

      session = await this.megaService.prepareDriveMirrorRoot([subjectName], "upload");

      this.logger.log(`[Mega:path] Ruta final de materia: ${session.sandboxLogicalPath}`);

      this.logger.log(`${rq} Carpeta Mega destino (completa): ${session.sandboxLogicalPath}`);



      const { uploadedFiles, failedFiles, totalFiles } = await this.mirrorDriveItemsIntoMegaSession(items, session, {

        allowPartialFileFailures: false,

        logPrefix: rq,

      });



      if (failedFiles > 0) {

        throw new BadRequestException(

          `La copia a Mega no se completó: ${failedFiles} archivo(s) fallaron de ${totalFiles}. ` +

            "Revisa el enlace de Drive, permisos de la cuenta de servicio y espacio o límites en Mega.",

        );

      }



      const megaFolderId = session.syncRootFolder.nodeId ?? "";
      let megaFolderLink: string | null = null;
      let megaStatus: MegaUploadResult["megaStatus"] = "created";

      try {
        megaFolderLink = await this.megaService.getFolderPublicLink(session.syncRootFolder);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        megaStatus = "created_without_public_link";
        if (megaFolderId.trim().length > 0) {
          megaFolderLink = `https://mega.nz/fm/${megaFolderId}`;
          this.logger.warn(
            `[Mega:link] No se pudo generar link público; se usa acceso interno Mega ${megaFolderLink}. Detalle: ${message}`,
          );
        } else {
          megaFolderLink = null;
          this.logger.warn(
            `[Mega:link] No se pudo generar link público, pero la carpeta fue creada correctamente. Sin megaFolderId para fallback interno. Detalle: ${message}`,
          );
        }
      }



      this.logger.log(`${rq} Sync Drive→Mega OK — ${uploadedFiles} archivo(s) subidos.`);



      return {

        megaFolderId,

        megaFolderLink,

        megaPath: session.sandboxLogicalPath,

        megaStatus,

        megaCreatedAt: new Date(),

      };

    } catch (err: unknown) {

      if (err instanceof HttpException) throw err;



      const msg = err instanceof Error ? err.message : String(err);

      this.logger.error(`${rq} Error Drive→Mega: ${msg}`);

      throw new BadRequestException(

        `No se pudo copiar el contenido de Google Drive a Mega. Detalle técnico: ${msg}`,

      );

    } finally {

      if (session?.storage) {

        await this.megaService.closeMegaSessionSafely(session.storage, "materia-create");

      }

    }

  }



  private async mirrorDriveItemsIntoMegaSession(

    items: DriveRecursiveListItem[],

    session: MegaDriveSyncSandbox,

    opts: { allowPartialFileFailures: boolean; logPrefix: string },

  ): Promise<{

    totalFolders: number;

    totalFiles: number;

    uploadedFiles: number;

    failedFiles: number;

  }> {

    const folders = items.filter((i) => i.isFolder);

    const files = items.filter((i) => !i.isFolder);



    const uniqueFolderPaths = [...new Set(folders.map((f) => f.path))];

    uniqueFolderPaths.sort((a, b) => this.driveSlashDepth(a) - this.driveSlashDepth(b));



    for (const driveFolderPath of uniqueFolderPaths) {

      try {

        await this.megaService.ensureDriveMirrorFolder(session.syncRootFolder, driveFolderPath);

        this.logger.log(`${opts.logPrefix} Carpeta Mega lista (mirror): ${driveFolderPath}`);

      } catch (error: unknown) {

        this.logger.error(

          `${opts.logPrefix} Error creando carpeta Mega para Drive path=${driveFolderPath}: ${String(error)}`,

        );

        throw error;

      }

    }



    let uploadedFiles = 0;

    let failedFiles = 0;



    const folderCache = new Map<string, MutableFile>();

    folderCache.set("", session.syncRootFolder);



    for (const driveFile of files) {

      try {

        this.logger.log(`${opts.logPrefix} Descargando Drive id=${driveFile.id} path=${driveFile.path}`);



        const downloaded = await this.googleDrive.downloadFile(driveFile.id);



        this.logger.log(

          `${opts.logPrefix} Descargado path=${driveFile.path} "${downloaded.fileName}" (${downloaded.buffer.length} bytes)`,

        );



        await this.megaService.uploadDriveSyncBlob(

          session.syncRootFolder,

          driveFile.path,

          downloaded.fileName,

          downloaded.buffer,

          folderCache,

        );



        uploadedFiles++;

        this.logger.log(`${opts.logPrefix} Subido a Mega pathDrive=${driveFile.path} archivo="${downloaded.fileName}"`);

      } catch (error: unknown) {

        failedFiles++;

        const message = error instanceof Error ? error.message : String(error);

        this.logger.error(

          `${opts.logPrefix} Fallo archivo Drive id=${driveFile.id} path=${driveFile.path} — ${message}`,

        );

        if (!opts.allowPartialFileFailures) {

          throw error;

        }

      }

    }



    return {

      totalFolders: folders.length,

      totalFiles: files.length,

      uploadedFiles,

      failedFiles,

    };

  }



  private driveSlashDepth(slashPath: string): number {

    return slashPath.replace(/^\/+/, "").split("/").filter(Boolean).length;

  }

}


