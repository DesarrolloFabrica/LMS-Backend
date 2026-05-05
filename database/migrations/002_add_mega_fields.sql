-- Migración 002: Agrega campos de Mega a la tabla materias.
--
-- Estos campos se llenan ANTES de insertar la fila en BD:
-- el backend primero copia la carpeta de Drive → Mega y,
-- solo si la copia termina sin errores, persiste la solicitud.
-- Si Mega falla la fila NUNCA se inserta.

ALTER TABLE materias ADD COLUMN IF NOT EXISTS mega_folder_id   TEXT;
ALTER TABLE materias ADD COLUMN IF NOT EXISTS mega_folder_link TEXT;
ALTER TABLE materias ADD COLUMN IF NOT EXISTS mega_path        TEXT;

-- Estado de la sincronización con Mega.
-- Valores posibles: 'created' | 'error' | 'pending'
ALTER TABLE materias ADD COLUMN IF NOT EXISTS mega_status      VARCHAR(30);
ALTER TABLE materias ADD COLUMN IF NOT EXISTS mega_created_at  TIMESTAMPTZ;
