/**
 * MegaService
 *
 * Responsabilidades:
 *  1. Conectarse a Mega con credenciales desde variables de entorno.
 *  2. Crear la ruta base: /Carga LMS/{semestre}/{programa}/{materia}-{requestId}
 *  3. Crear subcarpetas equivalentes a las encontradas en Drive.
 *  4. Subir todos los archivos descargados desde Drive.
 *  5. Retornar: megaFolderId, megaFolderLink, megaPath, megaStatus, megaCreatedAt.
 *
 * Nota: Se crea una conexión nueva por operación de copia (keepalive: false)
 * para evitar sesiones caducadas entre solicitudes.
 */

import { Injectable, Logger, InternalServerErrorException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Storage, MutableFile } from "megajs";
import type { DriveFile } from "@/integrations/google-drive/google-drive-import.service";

/** Resultado devuelto por uploadFolder. Se guarda en la fila de materias. */
export interface MegaUploadResult {
  megaFolderId: string;
  megaFolderLink: string;
  megaPath: string;
  megaStatus: "created";
  megaCreatedAt: Date;
}

@Injectable()
export class MegaService {
  private readonly logger = new Logger(MegaService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Orquesta la subida completa de una carpeta a Mega.
   *
   * Pasos internos:
   *  1. Conectar a Mega con las credenciales de .env.
   *  2. Navegar / crear la ruta: MEGA_BASE_PATH/{semestre}/{programa}/{subject}-{requestId}.
   *  3. Crear las subcarpetas necesarias (según los paths de los archivos de Drive).
   *  4. Subir cada archivo al lugar correcto.
   *  5. Obtener el link de la carpeta raíz de la solicitud y devolver metadatos.
   *
   * @param files      - Lista de archivos provenientes de GoogleDriveImportService.
   * @param semestre   - Código de semestre (ej: "2026-1").
   * @param programa   - Nombre del programa (ej: "Ingeniería de Sistemas").
   * @param subject    - Nombre de la materia (ej: "Computación gráfica").
   * @param requestId  - UUID único para diferenciar la solicitud.
   */
  async uploadFolder(
    files: DriveFile[],
    semestre: string,
    programa: string,
    subject: string,
    requestId: string,
  ): Promise<MegaUploadResult> {
    // ── Paso 1: conectar a Mega ────────────────────────────────────────────
    const storage = await this.connect();

    try {
      // ── Paso 2: construir / navegar la jerarquía de carpetas ─────────────
      const basePath = this.config.get<string>("mega.basePath") ?? "/Carga LMS";

      // Nombre de la carpeta raíz de esta solicitud
      const folderName = this.sanitizeName(`${subject}-${requestId}`);

      // Ruta lógica completa (solo para logging y para guardar en BD)
      const megaPath = `${basePath}/${semestre}/${this.sanitizeName(programa)}/${folderName}`;

      this.logger.log(`[Mega] Creando estructura: ${megaPath}`);

      // Navegar desde la raíz de Mega creando carpetas que no existan
      const rootFolder = await this.navigateOrCreate(storage.root, [
        this.sanitizeName(basePath.replace(/^\//, "")), // "Carga LMS"
        this.sanitizeName(semestre),
        this.sanitizeName(programa),
        folderName,
      ]);

      this.logger.log(`[Mega] Carpeta raíz creada: ${folderName}`);

      // ── Paso 3 y 4: crear subcarpetas y subir archivos ───────────────────
      // Mapa de ruta de directorio → MutableFile para no crear carpetas duplicadas
      const folderCache = new Map<string, MutableFile>();
      folderCache.set("", rootFolder); // la carpeta raíz se mapea al path vacío

      for (const file of files) {
        // La ruta relativa puede ser "archivo.pdf" o "subcarpeta/archivo.pdf"
        const parts = file.relativePath.split("/");
        const dirParts = parts.slice(0, -1); // sin el nombre del archivo

        // Obtener (o crear) la carpeta destino
        const targetFolder = await this.ensureFolderPath(rootFolder, dirParts, folderCache);

        // Subir el archivo
        this.logger.log(`[Mega] Subiendo "${file.relativePath}" (${file.buffer.length} bytes)`);
        await this.uploadFile(targetFolder, file.name, file.buffer);
      }

      // ── Paso 5: obtener el link público de la carpeta raíz ───────────────
      const megaFolderLink = await this.getFolderLink(rootFolder);
      const megaFolderId = rootFolder.nodeId ?? "";

      this.logger.log(`[Mega] Subida completada. Link: ${megaFolderLink}`);

      return {
        megaFolderId,
        megaFolderLink,
        megaPath,
        megaStatus: "created",
        megaCreatedAt: new Date(),
      };
    } finally {
      // Cerrar la sesión de Mega siempre, incluso si hubo error
      try {
        await storage.close();
      } catch {
        // Si el cierre falla, no propagamos el error
      }
    }
  }

  // ── Métodos privados ────────────────────────────────────────────────────────

  /**
   * Abre una sesión con Mega usando las credenciales del .env.
   * Lanza InternalServerErrorException si faltan credenciales o la conexión falla.
   */
  private async connect(): Promise<Storage> {
    const email = this.config.get<string>("mega.email");
    const password = this.config.get<string>("mega.password");

    if (!email || !password) {
      throw new InternalServerErrorException(
        "Faltan variables de entorno MEGA_EMAIL / MEGA_PASSWORD.",
      );
    }

    this.logger.log(`[Mega] Conectando como ${email}…`);

    try {
      const storage = new Storage({
        email,
        password,
        userAgent: "CargaLMS/1.0",
        // keepalive: false → la sesión se cierra manualmente con storage.close()
        keepalive: false,
      });

      await storage.ready;
      this.logger.log("[Mega] Sesión iniciada.");
      return storage;
    } catch (error) {
      this.logger.error(`[Mega] Error al conectar: ${String(error)}`);
      throw new InternalServerErrorException(`No se pudo conectar a Mega: ${String(error)}`);
    }
  }

  /**
   * Dada la raíz del storage, navega por la lista de segmentos creando
   * cada carpeta que no exista.
   *
   * Ejemplo: segments = ["Carga LMS", "2026-1", "Ingenieria de Sistemas", "Materia-uuid"]
   */
  private async navigateOrCreate(root: MutableFile, segments: string[]): Promise<MutableFile> {
    let current: MutableFile = root;

    for (const segment of segments) {
      current = await this.getOrCreateChild(current, segment);
    }

    return current;
  }

  /**
   * Busca un hijo con ese nombre en la carpeta actual;
   * si no existe lo crea.
   */
  private async getOrCreateChild(parent: MutableFile, name: string): Promise<MutableFile> {
    // children puede ser undefined si la carpeta está vacía
    const existing = (parent.children ?? []).find(
      (child) => child.directory && child.name === name,
    );

    if (existing) {
      this.logger.debug(`[Mega] Carpeta existente: "${name}"`);
      return existing as MutableFile;
    }

    this.logger.debug(`[Mega] Creando carpeta: "${name}"`);
    try {
      return await parent.mkdir(name);
    } catch (error) {
      this.logger.error(`[Mega] Error creando carpeta "${name}": ${String(error)}`);
      throw new InternalServerErrorException(`Error creando carpeta en Mega: "${name}"`);
    }
  }

  /**
   * Garantiza que exista la ruta de subcarpetas dentro de rootFolder
   * y devuelve la MutableFile hoja.
   * Usa folderCache para no repetir mkdir en la misma ejecución.
   */
  private async ensureFolderPath(
    root: MutableFile,
    dirParts: string[],
    cache: Map<string, MutableFile>,
  ): Promise<MutableFile> {
    if (dirParts.length === 0) return root;

    const cacheKey = dirParts.join("/");
    if (cache.has(cacheKey)) return cache.get(cacheKey)!;

    let current = root;
    for (let i = 0; i < dirParts.length; i++) {
      const partialKey = dirParts.slice(0, i + 1).join("/");
      if (cache.has(partialKey)) {
        current = cache.get(partialKey)!;
      } else {
        current = await this.getOrCreateChild(current, this.sanitizeName(dirParts[i]));
        cache.set(partialKey, current);
      }
    }

    return current;
  }

  /**
   * Sube un Buffer como archivo dentro de la carpeta targetFolder.
   * Retorna cuando la subida termina correctamente.
   */
  private async uploadFile(targetFolder: MutableFile, name: string, buffer: Buffer): Promise<void> {
    try {
      await targetFolder.upload(
        { name, size: buffer.length },
        buffer,
      );
    } catch (error) {
      this.logger.error(`[Mega] Error subiendo "${name}": ${String(error)}`);
      throw new InternalServerErrorException(`Error subiendo "${name}" a Mega.`);
    }
  }

  /**
   * Genera un link público para una carpeta de Mega.
   * El link tiene el formato: https://mega.nz/folder/{handle}#{key}
   */
  private async getFolderLink(folder: MutableFile): Promise<string> {
    try {
      return await folder.link({ noKey: false });
    } catch (error) {
      this.logger.warn(`[Mega] No se pudo generar link público: ${String(error)}`);
      // Devolver vacío es preferible a fallar la solicitud completa
      return "";
    }
  }

  /**
   * Limpia nombres para que sean seguros en rutas de Mega:
   * elimina barras, caracteres de control y espacios duplicados.
   */
  private sanitizeName(name: string): string {
    return name.replace(/[/\\]/g, "-").replace(/\s+/g, " ").trim();
  }
}
