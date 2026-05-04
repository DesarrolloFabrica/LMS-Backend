# GCP Test Environment

Arquitectura de pruebas:

```txt
Usuario navegador
  -> Cloud Run Frontend (React/Vite estatico)
  -> Cloud Run Backend (NestJS API)
  -> Cloud SQL PostgreSQL
  -> Secret Manager
```

## Comunicacion frontend/backend

El frontend no llama al backend desde la red interna de Cloud Run. La SPA corre en el navegador del usuario y llama al backend usando:

```env
VITE_API_BASE_URL=https://BACKEND_TEST_URL/api
```

Por eso el backend debe permitir CORS desde la URL del frontend:

```env
CORS_ORIGIN=https://FRONTEND_TEST_URL
APP_BASE_URL=https://FRONTEND_TEST_URL
SESSION_COOKIE_SECURE=true
SESSION_COOKIE_SAME_SITE=none
```

## GitHub Actions

El repo usa `.github/workflows/deploy-test.yml`.

## Que va en Secret Manager vs variables normales

Secret Manager obligatorio:

| Variable Cloud Run | Secreto sugerido | Motivo |
| --- | --- | --- |
| `DB_PASSWORD` | `carga-lms-test-db-password` | Password de Cloud SQL |
| `JWT_SECRET` | `carga-lms-test-jwt-secret` | Firma de sesiones JWT |
| `SMTP_USER` | `carga-lms-test-smtp-user` | Usuario de correo/relay |
| `SMTP_PASS` | `carga-lms-test-smtp-pass` | Password o app password |

Aunque SMTP no envie correos reales en pruebas, manten estos secretos creados para que test y prod tengan la misma forma de configuracion. Si aun no hay relay, usa valores placeholder y deja `SMTP_HOST` / `SMTP_FROM` vacios o de prueba.

Variables normales del servicio Cloud Run:

```txt
NODE_ENV
PORT
CORS_ORIGIN
APP_BASE_URL
DB_HOST
DB_PORT
DB_NAME
DB_USER
DB_SSL
DB_LOGGING
DB_SYNC
JWT_EXPIRES_IN
SESSION_COOKIE_NAME
SESSION_COOKIE_SECURE
SESSION_COOKIE_SAME_SITE
GOOGLE_CLIENT_ID
GOOGLE_ALLOWED_DOMAIN
LMS_NOTIFICATION_EMAIL
SMTP_HOST
SMTP_PORT
SMTP_SECURE
SMTP_FROM
```

`GOOGLE_CLIENT_ID` no es secreto: el frontend tambien lo usa publicamente.

Variables de GitHub del repo backend:

```txt
GCP_PROJECT_ID_TEST
GCP_REGION_TEST
GCP_ARTIFACT_REPOSITORY_TEST
CLOUD_RUN_BACKEND_SERVICE_TEST
CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT_TEST
CLOUD_SQL_INSTANCE_TEST
FRONTEND_URL_TEST
DB_NAME_TEST
DB_USER_TEST
GOOGLE_CLIENT_ID_TEST
GOOGLE_ALLOWED_DOMAIN_TEST
LMS_NOTIFICATION_EMAIL_TEST
SMTP_HOST_TEST
SMTP_FROM_TEST
```

Secrets de GitHub del repo backend:

```txt
GCP_WORKLOAD_IDENTITY_PROVIDER_TEST
GCP_SERVICE_ACCOUNT_TEST
DB_PASSWORD_SECRET_NAME_TEST
JWT_SECRET_SECRET_NAME_TEST
SMTP_USER_SECRET_NAME_TEST
SMTP_PASS_SECRET_NAME_TEST
```

Los secrets `*_SECRET_NAME_TEST` deben contener el nombre del secreto en Secret Manager, no el valor secreto.

Ejemplo:

```txt
DB_PASSWORD_SECRET_NAME_TEST=carga-lms-test-db-password
JWT_SECRET_SECRET_NAME_TEST=carga-lms-test-jwt-secret
```

## Secret Manager

Crear secretos de pruebas:

```bash
printf "PASSWORD_DB" | gcloud secrets create carga-lms-test-db-password --data-file=-
printf "JWT_LARGO_Y_UNICO" | gcloud secrets create carga-lms-test-jwt-secret --data-file=-
printf "correo@cun.edu.co" | gcloud secrets create carga-lms-test-smtp-user --data-file=-
printf "APP_PASSWORD" | gcloud secrets create carga-lms-test-smtp-pass --data-file=-
```

Permitir que el service account de Cloud Run lea secretos:

```bash
gcloud secrets add-iam-policy-binding carga-lms-test-db-password \
  --member="serviceAccount:SERVICE_ACCOUNT_EMAIL" \
  --role="roles/secretmanager.secretAccessor"
```

Repetir para cada secreto.

## Cloud SQL

La variable `CLOUD_SQL_INSTANCE_TEST` debe tener el formato:

```txt
PROJECT_ID:REGION:INSTANCE_NAME
```

Ejemplo:

```txt
mi-proyecto:us-central1:carga-lms-test
```

Aplicar migracion:

```bash
psql -h HOST -U USER -d control_lms -f database/migrations/001_initial_schema.sql
```

## Workload Identity Federation

El workflow usa autenticacion sin llaves JSON:

```yaml
permissions:
  contents: read
  id-token: write
```

El service account usado por GitHub Actions necesita permisos para:

- subir imagenes a Artifact Registry
- desplegar Cloud Run
- usar el service account runtime de Cloud Run si aplica

Roles tipicos:

```txt
roles/artifactregistry.writer
roles/run.admin
roles/iam.serviceAccountUser
```
