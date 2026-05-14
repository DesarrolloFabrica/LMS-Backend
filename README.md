# Carga LMS Backend

Backend NestJS para la plataforma de control operativo de cargue academico LMS.

## Stack

- NestJS 11
- Sequelize + sequelize-typescript
- PostgreSQL
- Google Identity Services
- Google Drive API con OAuth de usuario operador
- JWT interno en cookie HTTP-only
- Nodemailer para notificaciones SMTP

## Flujo de autenticacion

1. El frontend obtiene un ID token de Google Identity Services.
2. El frontend envia ese token a `POST /api/auth/google`.
3. El backend verifica el token contra Google.
4. El backend crea o actualiza el usuario local por `googleSub`.
5. El backend devuelve una sesion por cookie HTTP-only.

No hay passwords locales en esta aplicacion.

## Roles

- `FABRICA`: crea materias, consulta sus materias y reenvia correcciones.
- `LMS`: revisa, aprueba y devuelve materias.
- `ADMIN`: acceso completo.

El rol se guarda en base de datos. Todo usuario nuevo creado por Google inicia como `FABRICA`; luego un administrador puede ajustar el rol en la base de datos o desde una herramienta administrativa futura.

## Instalacion local

```bash
npm install
cp .env.example .env
npm run db:up
npm run start:dev
```

En PowerShell de Windows, si `npm` falla por execution policy, usa `npm.cmd`.

## Base de datos

La migracion canonica esta en:

```txt
database/migrations/001_initial_schema.sql
```

Con Docker Compose, la migracion se aplica automaticamente cuando el volumen de PostgreSQL es nuevo:

```bash
npm run db:up
```

Para una base existente:

```bash
psql -d control_lms -f database/migrations/001_initial_schema.sql
```

`DB_SYNC=true` solo debe usarse en desarrollo local. En produccion debe permanecer en `false`.

## Scripts

```bash
npm run build
npm run start
npm run start:prod
npm run start:dev
npm run lint
npm run format
```

## Variables de entorno

Usa `.env.example` para desarrollo y `.env.production.example` como guia para nube.

Variables clave de produccion:

```env
NODE_ENV=production
PORT=8080
CORS_ORIGIN=https://TU_FRONTEND_URL
DB_SSL=true
DB_SYNC=false
JWT_SECRET=GENERA_UN_SECRETO_LARGO_Y_UNICO
SESSION_COOKIE_SECURE=true
SESSION_COOKIE_SAME_SITE=none
GOOGLE_CLIENT_ID=TU_GOOGLE_CLIENT_ID
GOOGLE_ALLOWED_DOMAIN=cun.edu.co
GOOGLE_DRIVE_OPERATOR_CLIENT_ID=TU_OAUTH_CLIENT_ID_DE_DRIVE
GOOGLE_DRIVE_OPERATOR_CLIENT_SECRET=JSON_O_SECRET_DEL_OAUTH_CLIENT_DE_DRIVE
GOOGLE_DRIVE_OPERATOR_REFRESH_TOKEN=TU_REFRESH_TOKEN_DE_fabricadecontenidos
GOOGLE_DRIVE_DESTINATION_ROOT_FOLDER_ID=ID_CARPETA_RAIZ_UNIDAD_REVISORES
APP_BASE_URL=https://TU_FRONTEND_URL
```

Si frontend y backend quedan bajo el mismo site, puedes evaluar `SESSION_COOKIE_SAME_SITE=lax`. Si quedan en dominios distintos, usa `none` con `SESSION_COOKIE_SECURE=true`.

## Transferencia Drive a Drive

Al crear una materia, el backend lee la carpeta Drive origen y copia el material a una carpeta nueva dentro de la unidad compartida de revision. La copia se hace con Google Drive API usando OAuth del usuario operador `fabricadecontenidos@cun.edu.co`; no se usa service account para esta operacion y no se expone la unidad compartida origen a los revisores.

Variables de Drive:

```env
GOOGLE_DRIVE_OPERATOR_CLIENT_ID=
GOOGLE_DRIVE_OPERATOR_CLIENT_SECRET=
GOOGLE_DRIVE_OPERATOR_REFRESH_TOKEN=
GOOGLE_DRIVE_DESTINATION_ROOT_FOLDER_ID=
```

La cuenta operadora debe tener acceso de lectura a la unidad origen y permisos para crear contenido en la carpeta raiz destino.

`GOOGLE_DRIVE_OPERATOR_CLIENT_SECRET` acepta tres formatos:

- el client secret plano, por ejemplo `GOCSPX-...`
- el JSON completo descargado de Google Cloud
- una ruta local al archivo JSON, por ejemplo `client_secret.json`

En Cloud Run con Secret Manager, se recomienda guardar el JSON completo del OAuth client como secreto y exponerlo como variable de entorno `GOOGLE_DRIVE_OPERATOR_CLIENT_SECRET`. Cloud Run inyecta el valor del secreto, no el nombre del secreto.

## Endpoints principales

Auth:

- `POST /api/auth/google`
- `POST /api/auth/logout`
- `POST /api/auth/refresh`
- `GET /api/auth/me`

Catalogos:

- `GET /api/catalogs/academic-levels`
- `GET /api/catalogs/content-types`
- `GET /api/catalogs/semesters`
- `GET /api/catalogs/programs`
- `GET /api/catalogs/statuses`

Materias:

- `POST /api/materias`
- `GET /api/materias`
- `GET /api/materias/metrics`
- `GET /api/materias/activity`
- `GET /api/materias/:id`
- `PATCH /api/materias/:id`
- `PATCH /api/materias/:id/status`
- `GET /api/materias/:id/history`
- `GET /api/materias/:id/comments`
- `POST /api/materias/:id/comments`
- `GET /api/materias/fabrica/mine`
- `GET /api/materias/lms/inbox`
- `GET /api/materias/lms/completed`

Salud:

- `GET /api/health`

## Notificaciones

El modulo de notificaciones registra cada intento en `notification_logs` y, si SMTP esta configurado, envia correos reales.

```env
LMS_NOTIFICATION_EMAIL=lms@cun.edu.co
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=tu-correo@cun.edu.co
SMTP_PASS=tu-password-o-app-password
SMTP_FROM=tu-correo@cun.edu.co
```

Si SMTP no esta completo, la notificacion queda registrada como `SKIPPED`.

## Docker

Build local:

```bash
docker build -t carga-lms-backend .
```

Run local:

```bash
docker run --env-file .env -p 8080:8080 carga-lms-backend
```

## GCP / Cloud Run

El repo incluye:

- `Dockerfile`
- `.dockerignore`
- `.gcloudignore`
- `cloudbuild.yaml`

Build con Cloud Build:

```bash
gcloud builds submit --config cloudbuild.yaml --substitutions _IMAGE=us-central1-docker.pkg.dev/PROJECT_ID/carga-lms/backend:latest
```

Despliegue sugerido en Cloud Run:

```bash
gcloud run deploy carga-lms-backend \
  --image us-central1-docker.pkg.dev/PROJECT_ID/carga-lms/backend:latest \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars NODE_ENV=production,PORT=8080,DB_SYNC=false
```

Configura secretos sensibles con Secret Manager o variables de Cloud Run, no en el repositorio.

## Checklist antes de subir

- `.env` no debe subirse.
- `node_modules/`, `dist/` y `*.tsbuildinfo` no deben subirse.
- `JWT_SECRET` debe ser largo y unico en produccion.
- `DB_SYNC=false` en produccion.
- Aplicar las migraciones de `database/migrations/` en la base de Cloud SQL.
- Configurar OAuth de Google con el dominio/URL final.
- Configurar OAuth de Drive para `fabricadecontenidos@cun.edu.co` y la carpeta destino.
- Configurar `CORS_ORIGIN` con la URL real del frontend.
- Verificar `GET /api/health` despues del despliegue.
