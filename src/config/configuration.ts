export default () => ({
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 3000),
  database: {
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5432),
    name: process.env.DB_NAME ?? "control_lms",
    user: process.env.DB_USER ?? "postgres",
    password: process.env.DB_PASSWORD ?? "postgres",
    ssl: parseBoolean(process.env.DB_SSL),
    logging: parseBoolean(process.env.DB_LOGGING),
    sync: parseBoolean(process.env.DB_SYNC),
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? "change_me",
    expiresIn: process.env.JWT_EXPIRES_IN ?? "4h",
  },
  session: {
    cookieName: process.env.SESSION_COOKIE_NAME ?? "carga_lms_session",
    cookieSecure: process.env.SESSION_COOKIE_SECURE
      ? parseBoolean(process.env.SESSION_COOKIE_SECURE)
      : (process.env.NODE_ENV ?? "development") === "production",
    cookieSameSite: process.env.SESSION_COOKIE_SAME_SITE ?? "lax",
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    allowedDomain: process.env.GOOGLE_ALLOWED_DOMAIN,
  },
  bootstrapRoles: {
    defaultRole: process.env.DEFAULT_USER_ROLE,
    adminEmails: splitEnvList(process.env.INITIAL_ADMIN_EMAILS),
    lmsEmails: splitEnvList(process.env.INITIAL_LMS_EMAILS),
  },
  notifications: {
    lmsEmail: process.env.LMS_NOTIFICATION_EMAIL ?? "lms@cun.edu.co",
    appBaseUrl: process.env.APP_BASE_URL ?? "http://localhost:5173",
    smtpHost: optionalEnv("SMTP_HOST"),
    smtpPort: Number(optionalEnv("SMTP_PORT") ?? 587),
    smtpSecure: parseBoolean(process.env.SMTP_SECURE),
    smtpUser: optionalEnv("SMTP_USER"),
    smtpPass: optionalEnv("SMTP_PASS"),
    smtpFrom: optionalEnv("SMTP_FROM") ?? optionalEnv("SMTP_USER"),
  },
});

function parseBoolean(value?: string) {
  return value?.trim().toLowerCase() === "true";
}

function splitEnvList(value?: string) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function optionalEnv(key: string) {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}
