import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/sequelize";
import nodemailer, { Transporter } from "nodemailer";
import { Transaction } from "sequelize";
import { NotificationStatus } from "@/common/enums/notification-status.enum";
import { NotificationType } from "@/common/enums/notification-type.enum";
import { SubjectStatus } from "@/common/enums/subject-status.enum";
import { Subject } from "@/materias/models/subject.model";
import { NotificationLog } from "@/notifications/models/notification-log.model";
import { User } from "@/users/models/user.model";

type NotificationPayload = {
  subjectId: number;
  notificationType: NotificationType;
  recipientEmail: string;
  subjectLine: string;
  bodySnapshot: string;
  htmlBody: string;
};

type EmailAction = {
  label: string;
  href: string;
  variant?: "primary" | "secondary";
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private transporter?: Transporter;

  constructor(
    @InjectModel(NotificationLog) private readonly notificationLogModel: typeof NotificationLog,
    private readonly config: ConfigService,
  ) {}

  async logSubjectCreated(subject: Subject, actor: User, transaction?: Transaction) {
    const recipientEmail = this.config.getOrThrow<string>("notifications.lmsEmail");
    const textBody = [
      `Materia: ${subject.name}`,
      `Estado: ${this.statusLabel(subject.currentStatus)}`,
      `Nivel: ${subject.academicLevel}`,
      `Semestre: ${subject.semester}`,
      subject.programName ? `Programa: ${subject.programName}` : undefined,
      `Registrada por: ${actor.fullName} <${actor.email}>`,
      `Drive: ${subject.driveFolderUrl}`,
    ]
      .filter(Boolean)
      .join("\n");

    return this.createLog(
      {
        subjectId: subject.id,
        notificationType: NotificationType.SUBJECT_CREATED,
        recipientEmail,
        subjectLine: "[Control LMS] Nueva materia pendiente",
        bodySnapshot: textBody,
        htmlBody: this.renderSubjectEmail({
          eyebrow: "Nueva solicitud",
          title: "Materia pendiente",
          intro: "Fabrica de Contenido registro una nueva materia para revision del equipo LMS.",
          subject,
          statusLabel: this.statusLabel(subject.currentStatus),
          recipientHint: "Equipo LMS",
          actorLabel: "Registrada por",
          actorValue: `${actor.fullName} <${actor.email}>`,
          actions: [
            { label: "Abrir bandeja LMS", href: this.appUrl("/review"), variant: "primary" },
            { label: "Ver carpeta Drive", href: subject.driveFolderUrl, variant: "secondary" },
          ],
        }),
      },
      transaction,
    );
  }

  async logStatusUpdated(subject: Subject, creatorEmail: string, observation?: string, transaction?: Transaction) {
    const textBody = [
      `Materia: ${subject.name}`,
      `Estado: ${this.statusLabel(subject.currentStatus)}`,
      observation ? `Observacion: ${observation}` : undefined,
      subject.cdigitalUrl ? `C Digital: ${subject.cdigitalUrl}` : undefined,
      `Drive: ${subject.driveFolderUrl}`,
    ]
      .filter(Boolean)
      .join("\n");

    return this.createLog(
      {
        subjectId: subject.id,
        notificationType: this.typeForStatus(subject.currentStatus),
        recipientEmail: creatorEmail,
        subjectLine: this.subjectLineForStatus(subject.currentStatus),
        bodySnapshot: textBody,
        htmlBody: this.renderSubjectEmail({
          eyebrow: "Actualizacion de estado",
          title: this.statusTitle(subject.currentStatus),
          intro: this.statusIntro(subject.currentStatus),
          subject,
          statusLabel: this.statusLabel(subject.currentStatus),
          observation,
          recipientHint: "Fabrica de Contenido",
          actions: [
            { label: "Abrir plataforma", href: this.appUrl("/dashboard#drive-submission-form"), variant: "primary" },
            ...(subject.cdigitalUrl
              ? [{ label: "Ver en C Digital", href: subject.cdigitalUrl, variant: "secondary" } as EmailAction]
              : []),
            { label: "Ver carpeta Drive", href: subject.driveFolderUrl, variant: "secondary" },
          ],
        }),
      },
      transaction,
    );
  }

  async logSubjectReturnedForAdjustments(
    subject: Subject,
    creator: User,
    actor: User,
    observation?: string,
    transaction?: Transaction,
  ) {
    const textBody = [
      `Materia: ${subject.name}`,
      `Estado: ${this.statusLabel(subject.currentStatus)}`,
      `Nivel: ${subject.academicLevel}`,
      `Semestre: ${subject.semester}`,
      subject.programName ? `Programa: ${subject.programName}` : undefined,
      observation ? `Ajustes solicitados: ${observation}` : undefined,
      `Devuelta por: ${actor.fullName} <${actor.email}>`,
      `Drive: ${subject.driveFolderUrl}`,
    ]
      .filter(Boolean)
      .join("\n");

    return this.createLog(
      {
        subjectId: subject.id,
        notificationType: NotificationType.SUBJECT_RETURNED,
        recipientEmail: creator.email,
        subjectLine: "[Control LMS] Materia requiere ajustes",
        bodySnapshot: textBody,
        htmlBody: this.renderSubjectEmail({
          eyebrow: "Ajustes solicitados",
          title: "Materia requiere ajustes",
          intro: "El equipo LMS devolvio la materia para que Fabrica revise las observaciones y realice las correcciones necesarias.",
          subject,
          statusLabel: this.statusLabel(subject.currentStatus),
          observation,
          recipientHint: "Fabrica de Contenido",
          actorLabel: "Devuelta por",
          actorValue: `${actor.fullName} <${actor.email}>`,
          actions: [
            { label: "Revisar ajustes", href: this.appUrl("/dashboard#drive-submission-form"), variant: "primary" },
            { label: "Ver carpeta Drive", href: subject.driveFolderUrl, variant: "secondary" },
          ],
        }),
      },
      transaction,
    );
  }

  async logCorrectionsReady(subject: Subject, actor: User, recipientEmail?: string, transaction?: Transaction) {
    const to = recipientEmail ?? this.config.getOrThrow<string>("notifications.lmsEmail");
    const textBody = [
      `Materia: ${subject.name}`,
      `Estado: ${this.statusLabel(subject.currentStatus)}`,
      `Nivel: ${subject.academicLevel}`,
      `Semestre: ${subject.semester}`,
      subject.programName ? `Programa: ${subject.programName}` : undefined,
      `Correcciones notificadas por: ${actor.fullName} <${actor.email}>`,
      `Drive: ${subject.driveFolderUrl}`,
    ]
      .filter(Boolean)
      .join("\n");

    return this.createLog(
      {
        subjectId: subject.id,
        notificationType: NotificationType.SUBJECT_CORRECTIONS_READY,
        recipientEmail: to,
        subjectLine: "[Control LMS] Correcciones listas para revision",
        bodySnapshot: textBody,
        htmlBody: this.renderSubjectEmail({
          eyebrow: "Correcciones listas",
          title: "Materia corregida",
          intro: "Fabrica de Contenido notifico que ya realizo los ajustes solicitados. La materia vuelve a la bandeja LMS.",
          subject,
          statusLabel: this.statusLabel(subject.currentStatus),
          recipientHint: "Equipo LMS",
          actorLabel: "Corregida por",
          actorValue: `${actor.fullName} <${actor.email}>`,
          actions: [
            { label: "Abrir bandeja LMS", href: this.appUrl("/review"), variant: "primary" },
            { label: "Ver carpeta Drive", href: subject.driveFolderUrl, variant: "secondary" },
          ],
        }),
      },
      transaction,
    );
  }

  private async createLog(input: NotificationPayload, transaction?: Transaction) {
    const { htmlBody, ...logPayload } = input;
    const missingConfigurationReason = this.getMissingConfigurationReason();
    const log = await this.notificationLogModel.create(
      {
        ...logPayload,
        status: missingConfigurationReason ? NotificationStatus.SKIPPED : NotificationStatus.PENDING,
        errorMessage: missingConfigurationReason,
        sentAt: null,
      } as NotificationLog,
      { transaction },
    );

    if (missingConfigurationReason) {
      this.logger.log(`Notification skipped: notificationId=${log.id} type=${input.notificationType} subjectId=${input.subjectId} reason="${missingConfigurationReason}"`);
      return log;
    }

    try {
      await this.getTransporter().sendMail({
        from: this.config.get<string>("notifications.smtpFrom"),
        to: input.recipientEmail,
        subject: input.subjectLine,
        text: input.bodySnapshot,
        html: htmlBody,
      });

      await log.update(
        {
          status: NotificationStatus.SENT,
          errorMessage: null,
          sentAt: new Date(),
        },
        { transaction },
      );
      this.logger.log(`Notification sent: notificationId=${log.id} type=${input.notificationType} subjectId=${input.subjectId}`);
    } catch (error) {
      const errorMessage = this.getErrorMessage(error);
      this.logger.warn(`Email delivery failed for notification ${log.id}: ${errorMessage}`);
      await log.update(
        {
          status: NotificationStatus.FAILED,
          errorMessage,
          sentAt: null,
        },
        { transaction },
      );
    }

    return log;
  }

  private getTransporter() {
    if (!this.transporter) {
      const user = this.config.getOrThrow<string>("notifications.smtpUser");
      const pass = this.config.getOrThrow<string>("notifications.smtpPass");
      this.transporter = nodemailer.createTransport({
        host: this.config.get<string>("notifications.smtpHost"),
        port: this.config.getOrThrow<number>("notifications.smtpPort"),
        secure: this.config.getOrThrow<boolean>("notifications.smtpSecure"),
        auth: user && pass ? { user, pass } : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      });
    }

    return this.transporter;
  }

  private getMissingConfigurationReason() {
    const required = [
      ["SMTP_HOST", this.config.get<string>("notifications.smtpHost")],
      ["SMTP_FROM", this.config.get<string>("notifications.smtpFrom")],
    ];

    const missing = required.filter(([, value]) => !value).map(([key]) => key);
    const user = this.config.getOrThrow<string>("notifications.smtpUser");
    const pass = this.config.getOrThrow<string>("notifications.smtpPass");

    if ((user && !pass) || (!user && pass)) {
      missing.push(user ? "SMTP_PASS" : "SMTP_USER");
    }

    return missing.length ? `SMTP delivery is not fully configured. Missing: ${missing.join(", ")}.` : null;
  }

  private escapeHtml(value: string) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  private getErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : "Unknown email delivery error";
  }

  private renderSubjectEmail(input: {
    eyebrow: string;
    title: string;
    intro: string;
    subject: Subject;
    statusLabel: string;
    observation?: string;
    recipientHint: string;
    actorLabel?: string;
    actorValue?: string;
    actions: EmailAction[];
  }) {
    const details = [
      ["Materia", input.subject.name],
      ["Estado", input.statusLabel],
      ["Nivel academico", input.subject.academicLevel],
      ["Semestre", input.subject.semester],
      ["Programa", input.subject.programName],
      input.actorLabel && input.actorValue ? [input.actorLabel, input.actorValue] : undefined,
    ].filter((item): item is string[] => Boolean(item?.[1]));

    const actionButtons = input.actions
      .map((action) => {
        const isPrimary = action.variant !== "secondary";
        const background = isPrimary ? "#2563eb" : "#ffffff";
        const color = isPrimary ? "#ffffff" : "#2563eb";
        const border = isPrimary ? "#2563eb" : "#dbeafe";
        return `
          <a href="${this.escapeHtml(action.href)}" style="display:inline-block;margin:0 8px 10px 0;padding:12px 18px;border-radius:12px;border:1px solid ${border};background:${background};color:${color};font-size:14px;font-weight:700;text-decoration:none;">
            ${this.escapeHtml(action.label)}
          </a>
        `;
      })
      .join("");

    return `
<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${this.escapeHtml(input.title)}</title>
  </head>
  <body style="margin:0;padding:0;background:#eef4ff;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef4ff;padding:28px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;border-collapse:collapse;overflow:hidden;border-radius:22px;background:#ffffff;box-shadow:0 24px 80px rgba(15,23,42,0.14);">
            <tr>
              <td style="padding:0;background:#07102f;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:linear-gradient(135deg,#06112f 0%,#111a50 48%,#2563eb 100%);">
                  <tr>
                    <td style="padding:28px 30px;">
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                        <tr>
                          <td style="vertical-align:middle;">
                            <div style="display:inline-block;width:42px;height:42px;line-height:42px;text-align:center;border-radius:14px;background:#4f46e5;color:#ffffff;font-weight:800;font-size:14px;box-shadow:0 10px 28px rgba(79,70,229,0.45);">CL</div>
                            <span style="display:inline-block;margin-left:12px;vertical-align:middle;color:#ffffff;font-size:14px;font-weight:800;letter-spacing:4px;text-transform:uppercase;">Carga<br><span style="letter-spacing:3px;color:#bfdbfe;">System</span></span>
                          </td>
                          <td align="right" style="vertical-align:middle;">
                            <span style="display:inline-block;padding:7px 10px;border:1px solid rgba(147,197,253,0.45);border-radius:999px;color:#93c5fd;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;">Control LMS</span>
                          </td>
                        </tr>
                      </table>
                      <div style="height:26px;line-height:26px;">&nbsp;</div>
                      <div style="color:#60a5fa;font-size:12px;font-weight:800;letter-spacing:1.8px;text-transform:uppercase;">${this.escapeHtml(input.eyebrow)}</div>
                      <h1 style="margin:10px 0 0;color:#ffffff;font-size:30px;line-height:1.15;font-weight:800;">${this.escapeHtml(input.title)}</h1>
                      <p style="margin:14px 0 0;max-width:520px;color:#dbeafe;font-size:15px;line-height:1.65;">${this.escapeHtml(input.intro)}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 30px 8px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:0 10px;">
                  ${details
                    .map(
                      ([label, value]) => `
                        <tr>
                          <td style="width:160px;padding:13px 14px;background:#f8fbff;border-top-left-radius:12px;border-bottom-left-radius:12px;color:#64748b;font-size:12px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;">${this.escapeHtml(label)}</td>
                          <td style="padding:13px 14px;background:#f8fbff;border-top-right-radius:12px;border-bottom-right-radius:12px;color:#0f172a;font-size:14px;font-weight:700;">${this.escapeHtml(value)}</td>
                        </tr>
                      `,
                    )
                    .join("")}
                </table>
                ${
                  input.observation
                    ? `
                      <div style="margin:14px 0 0;padding:16px 18px;border-radius:14px;background:#fff7ed;border:1px solid #fed7aa;">
                        <div style="color:#9a3412;font-size:12px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;">Observacion LMS</div>
                        <p style="margin:8px 0 0;color:#431407;font-size:14px;line-height:1.6;">${this.escapeHtml(input.observation)}</p>
                      </div>
                    `
                    : ""
                }
                <div style="padding:20px 0 10px;">${actionButtons}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 30px 28px;border-top:1px solid #e2e8f0;background:#f8fbff;">
                <p style="margin:0;color:#64748b;font-size:12px;line-height:1.6;">
                  Este correo fue generado automaticamente por Carga System para ${this.escapeHtml(input.recipientHint)}.
                  Si no reconoces esta notificacion, revisa la plataforma o contacta al administrador del proceso.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
    `;
  }

  private appUrl(path: string) {
    const baseUrl = this.config.getOrThrow<string>("notifications.appBaseUrl");
    return `${baseUrl.replace(/\/$/, "")}${path}`;
  }

  private statusLabel(status: SubjectStatus) {
    const labels: Record<SubjectStatus, string> = {
      [SubjectStatus.PENDIENTE]: "PENDIENTE",
      [SubjectStatus.APROBADO]: "APROBADO",
      [SubjectStatus.REQUIERE_AJUSTES]: "REQUIERE AJUSTES",
    };

    return labels[status];
  }

  private statusTitle(status: SubjectStatus) {
    if (status === SubjectStatus.REQUIERE_AJUSTES) return "Materia requiere ajustes";
    if (status === SubjectStatus.APROBADO) return "Materia aprobada";
    if (status === SubjectStatus.PENDIENTE) return "Materia pendiente de revision LMS";
    return "Estado de materia actualizado";
  }

  private statusIntro(status: SubjectStatus) {
    if (status === SubjectStatus.REQUIERE_AJUSTES) {
      return "El equipo LMS solicito ajustes para que Fabrica revise y notifique las correcciones.";
    }
    if (status === SubjectStatus.APROBADO) {
      return "La materia fue aprobada por el equipo LMS.";
    }
    if (status === SubjectStatus.PENDIENTE) {
      return "La materia esta pendiente de revision por parte del equipo LMS.";
    }
    return "El estado de la materia cambio dentro del flujo de Control LMS.";
  }

  private typeForStatus(status: SubjectStatus) {
    if (status === SubjectStatus.REQUIERE_AJUSTES) return NotificationType.SUBJECT_RETURNED;
    if (status === SubjectStatus.APROBADO) return NotificationType.SUBJECT_COMPLETED;
    return NotificationType.SUBJECT_STATUS_UPDATED;
  }

  private subjectLineForStatus(status: SubjectStatus) {
    if (status === SubjectStatus.REQUIERE_AJUSTES) return "[Control LMS] Materia requiere ajustes";
    if (status === SubjectStatus.APROBADO) return "[Control LMS] Materia aprobada";
    return "[Control LMS] Actualizacion de estado de materia";
  }
}
