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

import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Storage, MutableFile } from "megajs";
import type { Writable } from "stream";
import type { DriveFile } from "@/integrations/google-drive/google-drive-import.service";

/** Stream de subida megajs: el `Promise` real está en `.complete`, no en el valor devuelto por `upload()`. */
type MegaUploadStream = Writable & { complete: Promise<unknown> };

/** Sandbox bajo Mega para sincronización Drive→Mega (pruebas): el caller debe cerrar `storage`. */
export interface MegaDriveSyncSandbox {
  storage: Storage;
  syncRootFolder: MutableFile;
  /** Ruta lógica dentro de la cuenta (p. ej. `/Carga LMS/DriveSyncTest-173`). */
  sandboxLogicalPath: string;
}

/** Respuesta esperada tras validar sesión Mega (solo diagnóstico; no incluye datos sensibles). */
export interface MegaConnectionTestResult {
  ok: true;
  /** Valor efectivo leído de `MEGA_BASE_PATH` / config. */
  basePath: string;
  /** `true` si `storage.ready` terminó y `storage.root` es utilizable como raíz Cloud Drive. */
  rootAvailable: true;
}

/** Resultado devuelto por uploadFolder. Se guarda en la fila de materias. */
export interface MegaUploadResult {
  megaFolderId: string;
  megaFolderLink: string | null;
  megaPath: string;
  megaStatus: "created" | "created_without_public_link";
  megaCreatedAt: Date;
}

@Injectable()
export class MegaService {
  private readonly logger = new Logger(MegaService.name);

  /** Evita dos `close()` sobre la misma instancia (provoca condiciones de carrera en megajs). */
  private readonly megaSessionsClosedOnce = new WeakSet<Storage>();

  constructor(private readonly config: ConfigService) {}

  /**
   * Comprueba que las variables `MEGA_*` permitan abrir sesión en Mega.nz y que la API
   * exponga la carpeta raíz del usuario tras `storage.ready`. No crea ni modifica rutas ni archivos.
   *
   * Credenciales: nunca van a logs ni a la respuesta HTTP.
   */
  async testConnection(): Promise<MegaConnectionTestResult> {
    const basePath = this.getMegaBasePath();
    this.logger.log("[Mega:test] Probando sesión con la API de Mega (sin crear carpetas).");

    const storage = await this.openMegaStorageSilently({ purpose: "test" });

    try {
      const root = storage.root;

      if (!root) {
        this.logger.warn("[Mega:test] storage.ready completó pero `root` es nulo/indefinido.");
        throw new ServiceUnavailableException(
          "Mega devolvió una sesión sin carpeta raíz accesible. Reintenta o revisa estado del servicio.",
        );
      }

      const rootAvailable = root.directory === true;

      if (!rootAvailable) {
        this.logger.warn("[Mega:test] Nodo raíz presente pero no figura como directorio.");
        throw new ServiceUnavailableException(
          "La raíz de la cuenta Mega no está disponible como carpeta. Revisa la respuesta de la API.",
        );
      }

      this.logger.log("[Mega:test] Raíz de almacenamiento accesible (sin listar ni subir contenido).");

      return {
        ok: true,
        basePath,
        rootAvailable: true,
      };
    } finally {
      await this.closeMegaSessionSafely(storage, "test-connection");
    }
  }

  /** Usado por sandbox Drive→Mega: cierre ordenado una sola vez, sin tumbar Node tras sync exitoso. */
  async closeMegaSessionSafely(storage: Storage | undefined | null, context: string): Promise<void> {
    if (!storage) return;

    if (this.megaSessionsClosedOnce.has(storage)) {
      this.logger.debug(`[Mega:close:${context}] omitido: cierre ya en curso/hecho para esta sesión.`);
      return;
    }

    const status = storage.status as string | undefined;
    if (status === "closed") {
      this.megaSessionsClosedOnce.add(storage);
      this.logger.debug(`[Mega:close:${context}] ya estaba en status closed.`);
      return;
    }

    this.megaSessionsClosedOnce.add(storage);

    await this.flushMegaDeferredWorkBeforeClose(context);

    try {
      await storage.close();
      this.logger.log(`[Mega:close:${context}] Sesión Mega cerrada sin errores graves.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.isBenignMegaPostCloseError(msg)) {
        this.logger.debug(`[Mega:close:${context}] Ignorado (post-cierre megajs): ${msg}`);
      } else {
        this.logger.warn(`[Mega:close:${context}] Error al cerrar — no se propaga para no tumbar Nest: ${msg}`);
      }
    }
  }

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
    const storage = await this.openMegaStorageSilently({ purpose: "upload" });

    try {
      // ── Paso 2: construir / navegar la jerarquía de carpetas ─────────────
      const basePath = this.getMegaBasePath();

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
      await this.closeMegaSessionSafely(storage, "upload-folder");
    }
  }

  /**
   * Construye debajo de `MEGA_BASE_PATH` una ruta de carpetas (cada cadena se sanitiza como un segmento).
   * La carpeta hoja es donde se montará el espejo del árbol Drive.
   */
  async prepareDriveMirrorRoot(
    extraSegmentsRaw: string[],
    purpose: "sync" | "upload" = "upload",
  ): Promise<MegaDriveSyncSandbox> {
    const safeTail = extraSegmentsRaw.map((seg) => this.sanitizeName(seg)).filter((s) => s.length > 0);

    if (safeTail.length === 0) {
      throw new InternalServerErrorException("Se requiere al menos un segmento de carpeta para el destino Mega.");
    }

    const storage = await this.openMegaStorageSilently({ purpose });

    try {
      const baseSegs = this.segmentsFromMegaBasePath();
      const syncRootFolder = await this.navigateOrCreate(storage.root, [...baseSegs, ...safeTail]);

      const logicalTail = [...baseSegs, ...safeTail].filter(Boolean);
      const sandboxLogicalPath = "/" + logicalTail.join("/").replace(/\/+/g, "/");

      this.logger.log(`[Mega:mirrorRoot] Destino Mega (ruta lógica): ${sandboxLogicalPath}`);

      return {
        storage,
        syncRootFolder,
        sandboxLogicalPath,
      };
    } catch (error: unknown) {
      await this.closeMegaSessionSafely(storage, `prepareDriveMirrorRoot-fail-${purpose}`);
      throw error;
    }
  }

  /**
   * Sandbox de pruebas: un solo segmento bajo `MEGA_BASE_PATH` (p. ej. `DriveSyncTest-…`).
   */
  async prepareDriveSyncSandbox(sandboxFolderName: string): Promise<MegaDriveSyncSandbox> {
    return this.prepareDriveMirrorRoot([sandboxFolderName], "sync");
  }

  /** URL pública tipo `https://mega.nz/folder/...` para una carpeta ya creada en sesión. */
  async getShareLinkForMutableFolder(folder: MutableFile): Promise<string> {
    return this.getFolderPublicLink(folder);
  }

  /**
   * Genera y valida el enlace público de una carpeta Mega.
   * Si no es posible obtener un link válido, falla para impedir persistencia inconsistente en BD.
   */
  async getFolderPublicLink(folder: MutableFile): Promise<string> {
    const maxAttempts = 5;
    const backoffMs = [1000, 2000, 4000, 8000, 12000];
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.getFolderLink(folder);
      } catch (error: unknown) {
        lastError = error;

        if (!this.isMegaEagainError(error)) {
          if (error instanceof BadRequestException) {
            throw error;
          }

          const msg = error instanceof Error ? error.message : String(error);
          throw new BadRequestException(
            `No se pudo generar el enlace público de la carpeta en Mega. Detalle técnico: ${msg}`,
          );
        }

        if (attempt === maxAttempts) {
          break;
        }

        this.logger.warn(`[Mega:link] intento ${attempt}/${maxAttempts} falló por EAGAIN, reintentando...`);
        await this.sleep(backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1]);
      }
    }

    const message =
      lastError instanceof Error
        ? lastError.message
        : typeof lastError === "string"
          ? lastError
          : "Error desconocido al generar enlace público en Mega.";

    throw new BadRequestException(
      `No se pudo generar el enlace público de la carpeta en Mega tras ${maxAttempts} intentos. Detalle técnico: ${message}`,
    );
  }

  /**
   * Replica una carpeta de Drive (solo metadatos de path tipo `/Videos/sub`) dentro de `syncRootFolder`.
   */
  async ensureDriveMirrorFolder(syncRootFolder: MutableFile, driveFolderSlashPath: string): Promise<void> {
    const inner = driveFolderSlashPath.replace(/^\/+/, "").replace(/\/+$/, "").trim();
    if (inner === "") return;

    const parts = inner.split("/").filter(Boolean).map((seg) => this.sanitizeName(seg));
    if (parts.some((s) => s.length === 0)) return;

    await this.navigateOrCreate(syncRootFolder, parts);
  }

  /**
   * Sube bytes bajo la raíz sandbox respetando el path de archivo de Drive (`/Videos/x.pdf`).
   * Reusa `folderCache` para acelerar resoluciones de carpetas repetidas en la misma ejecución.
   */
  async uploadDriveSyncBlob(
    syncRootFolder: MutableFile,
    driveFileSlashPath: string,
    canonicalFileName: string,
    buffer: Buffer,
    folderCache: Map<string, MutableFile>,
  ): Promise<void> {
    const normalized = driveFileSlashPath.replace(/^\/+/, "").trim();
    let dirPart = "";

    const lastIx = normalized.lastIndexOf("/");
    if (lastIx === -1) {
      dirPart = "";
    } else {
      dirPart = normalized.slice(0, lastIx).trim();
    }

    const dirSegments =
      dirPart === ""
        ? []
        : dirPart
            .split("/")
            .filter(Boolean)
            .map((seg) => this.sanitizeName(seg))
            .filter((s) => s.length > 0);

    const safeName = this.sanitizeName(canonicalFileName);
    const folder = await this.ensureFolderPath(syncRootFolder, dirSegments, folderCache);
    await this.uploadFile(folder, safeName, buffer);
  }

  // ── Métodos privados ────────────────────────────────────────────────────────

  private getMegaBasePath(): string {
    return this.config.get<string>("mega.basePath") ?? "/Carga LMS";
  }

  /** Segmentos sanitizados desde `MEGA_BASE_PATH`, p. ej. `/Carga LMS` → `[ "Carga LMS" ]`. */
  private segmentsFromMegaBasePath(): string[] {
    const raw = this.getMegaBasePath().replace(/^\/+|\/+$/g, "").trim();
    return raw.split("/").map((seg) => this.sanitizeName(seg)).filter(Boolean);
  }

  /**
   * Lee `MEGA_EMAIL` y `MEGA_PASSWORD` vía configuración Nest (mapeadas en `configuration.ts`).
   */
  private readMegaCredentials(): { email: string; password: string } {
    const email = this.config.get<string>("mega.email")?.trim();
    const password = this.config.get<string>("mega.password");

    if (!email) {
      throw new BadRequestException(
        "MEGA_EMAIL no está definida o está vacía. Añádela en el archivo de entorno y reinicia el backend.",
      );
    }

    if (!password?.trim()) {
      throw new BadRequestException(
        "MEGA_PASSWORD no está definida o está vacía. Añádela en el archivo de entorno y reinicia el backend.",
      );
    }

    return { email, password: password.trim() };
  }

  /**
   * Crea `{Storage}` y espera sesión lista. Los mensajes HTTP distinguen configuración incompleta,
   * login inválido y fallos de red/servidor. **No** registra usuario ni contraseña.
   */
  private async openMegaStorageSilently(params: {
    purpose: "test" | "upload" | "sync";
  }): Promise<Storage> {
    const { email, password } = this.readMegaCredentials();

    if (params.purpose === "upload" || params.purpose === "sync") {
      this.logger.log("[Mega] Iniciando sesión en Mega (credenciales no registradas).");
    }

    try {
      const storage = new Storage({
        email,
        password,
        userAgent: "CargaLMS/1.0",
        keepalive: false,
      });

      await storage.ready;

      if (params.purpose === "upload" || params.purpose === "sync") {
        this.logger.log("[Mega] Sesión lista.");
      }

      return storage;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[Mega] Fallo cliente Mega (${params.purpose}): ${message}`,
      );

      if (this.looksLikeMegaInvalidCredentials(message)) {
        throw new UnauthorizedException(
          "Credenciales de Mega inválidas (email o contraseña incorrectos, o cuenta restringida).",
        );
      }

      throw new ServiceUnavailableException(
        "No se pudo establecer sesión con los servidores de Mega (red, mantenimiento o error del cliente). " +
          "Revisa conectividad y reintenta.",
      );
    }
  }

  /** Heurística sobre mensajes típicos de megajs ante login incorrecto vs fallos transitorios. */
  private looksLikeMegaInvalidCredentials(message: string): boolean {
    const m = message.toLowerCase();
    return (
      m.includes("incorrect") ||
      m.includes("eauth") ||
      m.includes("invalid login") ||
      m.includes("invalid email") ||
      m.includes("wrong password") ||
      m.includes("bad password") ||
      (m.includes("invalid") && m.includes("credential")) ||
      (m.includes("authentication") && m.includes("fail"))
    );
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
      const stream = targetFolder.upload(
        { name, size: buffer.length },
        buffer,
      ) as MegaUploadStream;
      await stream.complete;
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
      const rawLink = await folder.link({ noKey: false });
      const link = String(rawLink ?? "").trim();

      if (!link) {
        this.logger.error("[Mega] Link público vacío para carpeta recién creada.");
        throw new BadRequestException(
          "Mega no devolvió un enlace público para la carpeta creada. Se cancela la creación de la materia.",
        );
      }

      if (!/^https:\/\/mega\.nz\/folder\//i.test(link)) {
        this.logger.error(`[Mega] Link público con formato inesperado: ${link}`);
        throw new BadRequestException(
          "Mega devolvió un enlace de carpeta con formato inválido. Se cancela la creación de la materia.",
        );
      }

      return link;
    } catch (error: unknown) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[Mega] No se pudo generar link público: ${message}`);
      throw new BadRequestException(
        `No se pudo generar el enlace público de la carpeta en Mega. Detalle técnico: ${message}`,
      );
    }
  }

  private isMegaEagainError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    const normalized = message.toUpperCase();
    return normalized.includes("EAGAIN") || normalized.includes("(-3)") || normalized.includes("CODE -3");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Deja que megajs termine microtareas / callbacks en vuelo antes de marcar la API como cerrada.
   * megajs cierra `api` de forma abrupta; si aún hay `request()` pendientes, aparece "API is closed".
   */
  private async flushMegaDeferredWorkBeforeClose(context: string): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    this.logger.debug(`[Mega:close:${context}] Buffer de callbacks drenado antes de logout.`);
  }

  private isBenignMegaPostCloseError(message: string): boolean {
    const m = message.toLowerCase();
    return m.includes("api is closed") || m.includes("storage is not ready");
  }

  /**
   * Limpia nombres para que sean seguros en rutas de Mega:
   * elimina barras, caracteres de control y espacios duplicados.
   */
  private sanitizeName(name: string): string {
    return name.replace(/[/\\]/g, "-").replace(/\s+/g, " ").trim();
  }
}
