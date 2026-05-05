export default () => ({
  nodeEnv: requiredEnv("NODE_ENV"),
  port: parseNumber("PORT"),
  database: {
    host: requiredEnv("DB_HOST"),
    port: parseNumber("DB_PORT"),
    name: requiredEnv("DB_NAME"),
    user: requiredEnv("DB_USER"),
    password: requiredEnv("DB_PASSWORD"),
    ssl: parseBoolean("DB_SSL"),
    logging: parseBoolean("DB_LOGGING"),
    sync: parseBoolean("DB_SYNC"),
  },
  jwt: {
    secret: requiredEnv("JWT_SECRET"),
    expiresIn: requiredEnv("JWT_EXPIRES_IN"),
  },
  session: {
    cookieName: requiredEnv("SESSION_COOKIE_NAME"),
    cookieSecure: parseBoolean("SESSION_COOKIE_SECURE"),
    cookieSameSite: requiredEnv("SESSION_COOKIE_SAME_SITE"),
  },
  google: {
    clientId: requiredEnv("GOOGLE_CLIENT_ID"),
    allowedDomain: optionalEnv("GOOGLE_ALLOWED_DOMAIN"),
  },
  notifications: {
    lmsEmail: requiredEnv("LMS_NOTIFICATION_EMAIL"),
    appBaseUrl: requiredEnv("APP_BASE_URL"),
    smtpHost: optionalEnv("SMTP_HOST"),
    smtpPort: parseNumber("SMTP_PORT"),
    smtpSecure: parseBoolean("SMTP_SECURE"),
    smtpUser: requiredEnv("SMTP_USER"),
    smtpPass: requiredEnv("SMTP_PASS"),
    smtpFrom: optionalEnv("SMTP_FROM"),
  },

  // ── Google Drive Service Account ──────────────────────────────────────────
  // Usada por GoogleDriveImportService para leer carpetas de Drive.
  // La private key llega escapada desde .env (los \n son literales);
  // el servicio los convierte a saltos de línea reales.
  googleDrive: {
    serviceAccountEmail: optionalEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
    serviceAccountPrivateKey: optionalEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"),
    // Opcional: si está definido, se impersona este usuario via domain-wide delegation.
    impersonatedUser: optionalEnv("GOOGLE_IMPERSONATED_USER"),
  },

  // ── Mega ──────────────────────────────────────────────────────────────────
  // Usada por MegaService para subir archivos.
  // MEGA_BASE_PATH define la raíz dentro de la cuenta (default: /Carga LMS).
  mega: {
    email: optionalEnv("MEGA_EMAIL"),
    password: optionalEnv("MEGA_PASSWORD"),
    basePath: process.env.MEGA_BASE_PATH ?? "/Carga LMS",
  },
});

function requiredEnv(key: string) {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string) {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function parseNumber(key: string) {
  const raw = requiredEnv(key);
  const value = Number(raw);
  if (Number.isNaN(value)) {
    throw new Error(`Environment variable ${key} must be a valid number.`);
  }
  return value;
}

function parseBoolean(key: string) {
  const raw = requiredEnv(key).toLowerCase();
  if (raw !== "true" && raw !== "false") {
    throw new Error(`Environment variable ${key} must be "true" or "false".`);
  }
  return raw === "true";
}
