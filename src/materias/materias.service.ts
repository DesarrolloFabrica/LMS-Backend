import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import archiver from "archiver";
import { execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Response } from "express";
import { col, fn, literal, Op, Transaction, WhereOptions } from "sequelize";
import { Sequelize } from "sequelize-typescript";
import { promisify } from "node:util";
import { AuditService, FieldChange } from "@/audit/audit.service";
import { AuditLog } from "@/audit/models/audit-log.model";
import { AuthUser } from "@/auth/types/auth-user.type";
import { CommentType } from "@/common/enums/comment-type.enum";
import { ContentTypeCode } from "@/common/enums/content-type-code.enum";
import { SubjectStatus } from "@/common/enums/subject-status.enum";
import { UserRole } from "@/common/enums/user-role.enum";
import { ContentType } from "@/catalogs/models/content-type.model";
import { Program } from "@/catalogs/models/program.model";
import { Semester } from "@/catalogs/models/semester.model";
import { CreateCommentDto } from "@/materias/dto/create-comment.dto";
import { CreateSubjectDto } from "@/materias/dto/create-subject.dto";
import { QuerySubjectsDto } from "@/materias/dto/query-subjects.dto";
import { UpdateSubjectDto } from "@/materias/dto/update-subject.dto";
import { UpdateSubjectStatusDto } from "@/materias/dto/update-subject-status.dto";
import { Comment } from "@/materias/models/comment.model";
import { StatusHistory } from "@/materias/models/status-history.model";
import { SubjectContentType } from "@/materias/models/subject-content-type.model";
import { SubjectTimelineEvent } from "@/materias/models/subject-timeline-event.model";
import { SubjectTransferFile } from "@/materias/models/subject-transfer-file.model";
import { Subject } from "@/materias/models/subject.model";
import { NotificationLog } from "@/notifications/models/notification-log.model";
import { NotificationsService } from "@/notifications/notifications.service";
import { DriveService } from "@/transfers/drive.service";
import { TransferService } from "@/transfers/transfer.service";
import { User } from "@/users/models/user.model";

type SubjectWhere = WhereOptions<Subject> & {
  createdByUserId?: number;
  currentStatus?: unknown;
  semester?: string;
  academicLevel?: unknown;
  programName?: string;
};

const VALID_TRANSITIONS: Record<SubjectStatus, SubjectStatus[]> = {
  [SubjectStatus.PENDIENTE]: [SubjectStatus.APROBADO, SubjectStatus.REQUIERE_AJUSTES],
  [SubjectStatus.REQUIERE_AJUSTES]: [SubjectStatus.PENDIENTE],
  [SubjectStatus.APROBADO]: [],
};

const execFileAsync = promisify(execFile);
const OFFICE_PREVIEW_EXTENSIONS = new Set([".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"]);

type TimelineActor = Pick<User, "id" | "email" | "fullName" | "role"> | null;

type TimelineEntry = {
  id: string;
  type: string;
  title: string;
  description?: string | null;
  actor?: TimelineActor;
  createdAt: Date;
  metadata?: Record<string, unknown> | null;
};

@Injectable()
export class MateriasService {
  private readonly logger = new Logger(MateriasService.name);

  constructor(
    private readonly sequelize: Sequelize,
    @InjectModel(Subject) private readonly subjectModel: typeof Subject,
    @InjectModel(ContentType) private readonly contentTypeModel: typeof ContentType,
    @InjectModel(Program) private readonly programModel: typeof Program,
    @InjectModel(Semester) private readonly semesterModel: typeof Semester,
    @InjectModel(StatusHistory) private readonly statusHistoryModel: typeof StatusHistory,
    @InjectModel(SubjectContentType) private readonly subjectContentTypeModel: typeof SubjectContentType,
    @InjectModel(SubjectTransferFile) private readonly subjectTransferFileModel: typeof SubjectTransferFile,
    @InjectModel(SubjectTimelineEvent) private readonly subjectTimelineEventModel: typeof SubjectTimelineEvent,
    @InjectModel(Comment) private readonly commentModel: typeof Comment,
    @InjectModel(NotificationLog) private readonly notificationLogModel: typeof NotificationLog,
    @InjectModel(AuditLog) private readonly auditLogModel: typeof AuditLog,
    @InjectModel(User) private readonly userModel: typeof User,
    private readonly notificationsService: NotificationsService,
    private readonly auditService: AuditService,
    private readonly transferService: TransferService,
    private readonly driveService: DriveService,
  ) {}

  async create(dto: CreateSubjectDto, user: AuthUser) {
    if (user.role !== UserRole.FABRICA && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException("Only Fabrica or Admin can create materias");
    }

    const subject = await this.sequelize.transaction(async (transaction) => {
      const contentTypes = await this.resolveContentTypes(dto.contentTypeCodes, transaction);
      await this.assertActiveSemester(dto.semester, transaction);
      await this.assertActiveProgram(dto.programName, transaction);

      const subject = await this.subjectModel.create(
        {
          name: dto.name,
          semester: dto.semester,
          academicLevel: dto.academicLevel,
          programName: dto.programName,
          contentDescription: dto.contentDescription,
          driveFolderUrl: dto.driveFolderUrl,
          currentStatus: SubjectStatus.PENDIENTE,
          createdByUserId: user.sub,
        } as Subject,
        { transaction },
      );

      await (subject as any).$set("contentTypes", contentTypes, { transaction });
      await this.statusHistoryModel.create(
        {
          subjectId: subject.id,
          previousStatus: null,
          newStatus: SubjectStatus.PENDIENTE,
          changedByUserId: user.sub,
          observation: "Materia creada y enviada a LMS.",
        } as StatusHistory,
        { transaction },
      );
      await this.subjectTimelineEventModel.create(
        {
          subjectId: subject.id,
          eventType: "SUBJECT_CREATED",
          title: "Solicitud creada",
          description: "Fabrica registro la solicitud y la envio a LMS.",
          actorUserId: user.sub,
          metadata: {
            status: SubjectStatus.PENDIENTE,
            semester: subject.semester,
            programName: subject.programName,
          },
        } as Partial<SubjectTimelineEvent> as SubjectTimelineEvent,
        { transaction },
      );
      this.logger.log(`Materia created: subjectId=${subject.id} creatorUserId=${user.sub} semester=${subject.semester} program="${subject.programName}"`);

      return subject;
    });

    try {
      const transferResult = await this.transferService.copyDriveFolderToReviewDrive({
        driveFolderUrl: subject.driveFolderUrl,
        subjectId: subject.id,
        subjectName: subject.name,
        transferId: dto.transferId,
      });
      const transferredFiles = transferResult.files;
      await this.subjectTransferFileModel.bulkCreate(
        transferredFiles.map(
          (file) =>
            ({
              subjectId: subject.id,
              fileName: file.fileName,
              filePath: file.filePath,
              driveFileId: file.driveFileId,
              driveUrl: file.driveUrl,
              sizeBytes: file.sizeBytes ?? null,
              mimeType: file.mimeType ?? null,
            }) as SubjectTransferFile,
        ),
      );
      await subject.update({ cdigitalUrl: transferResult.folderUrl });
      await this.subjectTimelineEventModel.create({
        subjectId: subject.id,
        eventType: "TRANSFER_COMPLETED",
        title: "Material copiado al Drive de revision",
        description: `${transferredFiles.length} archivo(s) quedaron disponibles para revision.`,
        actorUserId: user.sub,
        metadata: {
          fileCount: transferredFiles.length,
          totalBytes: transferredFiles.reduce((sum, file) => sum + Number(file.sizeBytes ?? 0), 0),
          destinationFolderUrl: transferResult.folderUrl,
        },
      } as Partial<SubjectTimelineEvent> as SubjectTimelineEvent);
      const actor = await this.getUserOrFail(user.sub);
      await this.notificationsService.logSubjectCreated(subject, actor);
      this.logger.log(`Materia review Drive files generated: subjectId=${subject.id} fileCount=${transferredFiles.length}`);
      return this.findOne(subject.id, user);
    } catch (error) {
      if (dto.transferId) {
        this.transferService.failProgress(dto.transferId, error instanceof Error ? error.message : "Transfer failed");
      }
      await this.rollbackFailedCreate(subject.id);
      throw error;
    }
  }

  async findAll(query: QuerySubjectsDto, user: AuthUser) {
    const where = this.buildAuthorizedWhere(query, user);

    return this.subjectModel.findAll({
      where: where as never,
      include: this.defaultInclude(),
      order: [["createdAt", "DESC"]],
    });
  }

  async metrics(query: QuerySubjectsDto, user: AuthUser) {
    const where = this.buildAuthorizedWhere(query, user);
    const rows = await this.subjectModel.findAll({
      attributes: ["currentStatus", [fn("COUNT", col("id")), "count"]],
      where: where as never,
      group: ["currentStatus"],
      raw: true,
    });

    const byStatus = Object.values(SubjectStatus).reduce(
      (acc, status) => ({ ...acc, [status]: 0 }),
      {} as Record<SubjectStatus, number>,
    );

    for (const row of rows as unknown as Array<{ currentStatus: SubjectStatus; count: string }>) {
      byStatus[row.currentStatus] = Number(row.count);
    }

    const todayCount = await this.subjectModel.count({
      where: {
        ...where,
        createdAt: { [Op.gte]: this.startOfToday() },
      } as never,
    });

    const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
    return {
      total,
      active: total - byStatus[SubjectStatus.APROBADO],
      pending: byStatus[SubjectStatus.PENDIENTE],
      requiresAdjustments: byStatus[SubjectStatus.REQUIERE_AJUSTES],
      approved: byStatus[SubjectStatus.APROBADO],
      today: todayCount,
      byStatus,
    };
  }

  async activity(query: QuerySubjectsDto, user: AuthUser) {
    const subjectWhere = this.buildAuthorizedWhere(query, user);
    const subjectIds = await this.subjectModel.findAll({
      attributes: ["id"],
      where: subjectWhere as never,
      raw: true,
    });
    const ids = (subjectIds as unknown as Array<{ id: number }>).map((subject) => subject.id);
    if (ids.length === 0) return [];

    const [history, comments] = await Promise.all([
      this.statusHistoryModel.findAll({
        where: { subjectId: { [Op.in]: ids } },
        include: [
          { model: Subject, attributes: ["id", "name", "currentStatus"] },
          { model: User, as: "changedByUser", attributes: ["id", "email", "fullName", "role"] },
        ],
        order: [["createdAt", "DESC"]],
        limit: 80,
      }),
      this.commentModel.findAll({
        where: { subjectId: { [Op.in]: ids } },
        include: [
          { model: Subject, attributes: ["id", "name", "currentStatus"] },
          { model: User, as: "author", attributes: ["id", "email", "fullName", "role"] },
        ],
        order: [["createdAt", "DESC"]],
        limit: 80,
      }),
    ]);

    return [
      ...history.map((item) => ({
        id: `status-${item.id}`,
        type: "Estado",
        subjectId: item.subjectId,
        subjectName: item.subject?.name ?? "Materia",
        text: `${item.subject?.name ?? "Materia"} cambio a ${item.newStatus}`,
        actor: item.changedByUser?.fullName ?? item.changedByUser?.email ?? "Sistema",
        linkedStatus: item.newStatus,
        createdAt: item.createdAt,
      })),
      ...comments.map((item) => ({
        id: `comment-${item.id}`,
        type: item.commentType,
        subjectId: item.subjectId,
        subjectName: item.subject?.name ?? "Materia",
        text: `${item.subject?.name ?? "Materia"} recibio comentario: ${item.content}`,
        actor: item.author?.fullName ?? item.author?.email ?? "Sistema",
        linkedStatus: item.subject?.currentStatus,
        createdAt: item.createdAt,
      })),
    ]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 100);
  }

  async findMine(query: QuerySubjectsDto, user: AuthUser) {
    return this.subjectModel.findAll({
      where: { ...this.buildWhere(query), createdByUserId: user.sub } as never,
      include: this.defaultInclude(),
      order: [["createdAt", "DESC"]],
    });
  }

  transferProgress(transferId: string) {
    return this.transferService.progress(transferId);
  }

  async findLmsInbox(query: QuerySubjectsDto) {
    return this.subjectModel.findAll({
      where: {
        ...this.buildWhere(query),
        currentStatus: query.status ?? SubjectStatus.PENDIENTE,
      } as never,
      include: this.defaultInclude(),
      order: [["createdAt", "ASC"]],
    });
  }

  async findLmsCompleted(query: QuerySubjectsDto) {
    return this.subjectModel.findAll({
      where: {
        ...this.buildWhere(query),
        currentStatus: SubjectStatus.APROBADO,
      } as never,
      include: this.defaultInclude(),
      order: [["completedAt", "DESC"]],
    });
  }

  async uploadHistory(query: QuerySubjectsDto, user: AuthUser) {
    const subjects = await this.subjectModel.findAll({
      where: this.buildAuthorizedWhere(query, user) as never,
      include: [
        { model: User, as: "createdBy", attributes: ["id", "email", "fullName", "role"] },
        { model: User, as: "assignedLmsUser", attributes: ["id", "email", "fullName", "role"] },
        { model: SubjectTransferFile, as: "transferFiles" },
      ],
      order: [["createdAt", "DESC"]],
    });

    return subjects.map((subject) => {
      const files = subject.transferFiles ?? [];
      const uploadedAtValues = files.map((file) => file.createdAt).filter(Boolean);
      const lastUploadedAt = uploadedAtValues.length > 0
        ? new Date(Math.max(...uploadedAtValues.map((date) => date.getTime())))
        : null;
      const firstUploadedAt = uploadedAtValues.length > 0
        ? new Date(Math.min(...uploadedAtValues.map((date) => date.getTime())))
        : null;
      const rootFolders = Array.from(new Set(files.map((file) => file.filePath?.[0]).filter(Boolean))).sort();
      const folderKeys = new Set(
        files.flatMap((file) =>
          (file.filePath ?? []).map((_, index, path) => path.slice(0, index + 1).join("/")),
        ),
      );

      return {
        subjectId: subject.id,
        subjectName: subject.name,
        semester: subject.semester,
        academicLevel: subject.academicLevel,
        programName: subject.programName,
        currentStatus: subject.currentStatus,
        createdAt: subject.createdAt,
        completedAt: subject.completedAt,
        reviewedAt: subject.reviewedAt,
        createdBy: subject.createdBy
          ? {
              id: subject.createdBy.id,
              email: subject.createdBy.email,
              fullName: subject.createdBy.fullName,
              role: subject.createdBy.role,
            }
          : null,
        assignedLmsUser: subject.assignedLmsUser
          ? {
              id: subject.assignedLmsUser.id,
              email: subject.assignedLmsUser.email,
              fullName: subject.assignedLmsUser.fullName,
              role: subject.assignedLmsUser.role,
            }
          : null,
        fileCount: files.length,
        folderCount: folderKeys.size,
        totalBytes: files.reduce((sum, file) => sum + Number(file.sizeBytes ?? 0), 0),
        firstUploadedAt,
        lastUploadedAt,
        rootFolders: rootFolders.slice(0, 6),
        hasFiles: files.length > 0,
      };
    });
  }

  async findOne(id: number, user: AuthUser, transaction?: Transaction) {
    const subject = await this.subjectModel.findByPk(id, {
      include: this.defaultInclude(),
      transaction,
    });

    if (!subject) {
      throw new NotFoundException("Materia not found");
    }

    this.assertCanRead(subject, user);
    return subject;
  }

  async update(id: number, dto: UpdateSubjectDto, user: AuthUser) {
    return this.sequelize.transaction(async (transaction) => {
      const subject = await this.subjectModel.findByPk(id, { transaction });
      if (!subject) throw new NotFoundException("Materia not found");

      this.assertCanEditBaseData(subject, user);
      if (dto.semester) {
        await this.assertActiveSemester(dto.semester, transaction);
      }
      if (dto.programName) {
        await this.assertActiveProgram(dto.programName, transaction);
      }

      const changes: FieldChange[] = [
        { fieldName: "name", oldValue: subject.name, newValue: dto.name },
        { fieldName: "semester", oldValue: subject.semester, newValue: dto.semester },
        { fieldName: "academicLevel", oldValue: subject.academicLevel, newValue: dto.academicLevel },
        { fieldName: "programName", oldValue: subject.programName, newValue: dto.programName },
        { fieldName: "contentDescription", oldValue: subject.contentDescription, newValue: dto.contentDescription },
        { fieldName: "driveFolderUrl", oldValue: subject.driveFolderUrl, newValue: dto.driveFolderUrl },
      ].filter((change) => change.newValue !== undefined);

      await subject.update(
        {
          name: dto.name ?? subject.name,
          semester: dto.semester ?? subject.semester,
          academicLevel: dto.academicLevel ?? subject.academicLevel,
          programName: dto.programName ?? subject.programName,
          contentDescription: dto.contentDescription ?? subject.contentDescription,
          driveFolderUrl: dto.driveFolderUrl ?? subject.driveFolderUrl,
        },
        { transaction },
      );

      if (dto.contentTypeCodes) {
        const contentTypes = await this.resolveContentTypes(dto.contentTypeCodes, transaction);
        await (subject as any).$set("contentTypes", contentTypes, { transaction });
        changes.push({
          fieldName: "contentTypeCodes",
          oldValue: "updated through relation",
          newValue: dto.contentTypeCodes,
        });
      }

      await this.auditService.logFieldChanges(id, user.sub, changes, transaction);
      if (changes.length > 0) {
        this.logger.log(`Materia updated: subjectId=${id} actorUserId=${user.sub} changedFields=${changes.map((change) => change.fieldName).join(",")}`);
      }

      return this.findOne(id, user, transaction);
    });
  }

  async updateStatus(id: number, dto: UpdateSubjectStatusDto, user: AuthUser) {
    return this.sequelize.transaction(async (transaction) => {
      const subject = await this.subjectModel.findByPk(id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!subject) throw new NotFoundException("Materia not found");
      const creator = await this.userModel.findByPk(subject.createdByUserId, { transaction });
      if (!creator) throw new NotFoundException("Subject creator not found");
      const actor = await this.getUserOrFail(user.sub, transaction);
      const assignedLmsUser = subject.assignedLmsUserId
        ? await this.userModel.findByPk(subject.assignedLmsUserId, { transaction })
        : null;

      this.assertStatusPermission(subject, dto.newStatus, user);
      this.assertValidTransition(subject.currentStatus, dto.newStatus);

      const previousStatus = subject.currentStatus;
      const patch: Partial<Subject> = {
        currentStatus: dto.newStatus,
      };

      if (dto.assignedLmsUserId) {
        await this.getUserOrFail(dto.assignedLmsUserId, transaction);
        patch.assignedLmsUserId = dto.assignedLmsUserId;
      } else if ([UserRole.LMS, UserRole.ADMIN].includes(user.role) && !subject.assignedLmsUserId) {
        patch.assignedLmsUserId = user.sub;
      }

      if (
        [SubjectStatus.APROBADO, SubjectStatus.REQUIERE_AJUSTES].includes(dto.newStatus) &&
        !subject.reviewedAt
      ) {
        patch.reviewedAt = new Date();
      }

      if (dto.newStatus === SubjectStatus.APROBADO) {
        const cdigitalUrl = dto.cdigitalUrl?.trim() ?? subject.cdigitalUrl?.trim();
        if (cdigitalUrl) {
          patch.cdigitalUrl = cdigitalUrl;
        }
        patch.completedAt = new Date();
      } else if (dto.newStatus === SubjectStatus.PENDIENTE) {
        patch.completedAt = null;
      }

      await subject.update(patch, { transaction });
      await this.statusHistoryModel.create(
        {
          subjectId: subject.id,
          previousStatus,
          newStatus: dto.newStatus,
          changedByUserId: user.sub,
          observation: dto.observation ?? null,
        } as StatusHistory,
        { transaction },
      );

      if (dto.observation) {
        await this.commentModel.create(
          {
            subjectId: subject.id,
            authorUserId: user.sub,
            authorRole: user.role,
            commentType: this.commentTypeForStatus(dto.newStatus),
            content: dto.observation,
          } as Comment,
          { transaction },
        );
      }

      const correctionsReady =
        previousStatus === SubjectStatus.REQUIERE_AJUSTES &&
        dto.newStatus === SubjectStatus.PENDIENTE &&
        user.role === UserRole.FABRICA;

      if (correctionsReady) {
        await this.notificationsService.logCorrectionsReady(subject, actor, assignedLmsUser?.email, transaction);
      } else if (dto.newStatus === SubjectStatus.REQUIERE_AJUSTES && user.role !== UserRole.FABRICA) {
        await this.notificationsService.logSubjectReturnedForAdjustments(
          subject,
          creator,
          actor,
          dto.observation,
          transaction,
        );
      } else if (user.role !== UserRole.FABRICA) {
        await this.notificationsService.logStatusUpdated(subject, creator.email, dto.observation, transaction);
      }

      this.logger.log(`Materia status changed: subjectId=${id} actorUserId=${user.sub} previousStatus=${previousStatus} newStatus=${dto.newStatus}`);
      return this.findOne(id, user, transaction);
    });
  }

  async history(id: number, user: AuthUser) {
    await this.findOne(id, user);
    return this.statusHistoryModel.findAll({
      where: { subjectId: id },
      include: [{ model: User, as: "changedByUser", attributes: ["id", "email", "fullName", "role"] }],
      order: [["createdAt", "ASC"]],
    });
  }

  async comments(id: number, user: AuthUser) {
    await this.findOne(id, user);
    return this.commentModel.findAll({
      where: { subjectId: id },
      include: [{ model: User, as: "author", attributes: ["id", "email", "fullName", "role"] }],
      order: [["createdAt", "ASC"]],
    });
  }

  async timeline(id: number, user: AuthUser) {
    const subject = await this.findOne(id, user);
    const [events, history, comments, notifications, auditLogs, transferFiles] = await Promise.all([
      this.subjectTimelineEventModel.findAll({
        where: { subjectId: id },
        include: [{ model: User, as: "actor", attributes: ["id", "email", "fullName", "role"] }],
        order: [["createdAt", "ASC"]],
      }),
      this.statusHistoryModel.findAll({
        where: { subjectId: id },
        include: [{ model: User, as: "changedByUser", attributes: ["id", "email", "fullName", "role"] }],
        order: [["createdAt", "ASC"]],
      }),
      this.commentModel.findAll({
        where: { subjectId: id },
        include: [{ model: User, as: "author", attributes: ["id", "email", "fullName", "role"] }],
        order: [["createdAt", "ASC"]],
      }),
      this.notificationLogModel.findAll({
        where: { subjectId: id },
        order: [["createdAt", "ASC"]],
      }),
      this.auditLogModel.findAll({
        where: { subjectId: id },
        include: [{ model: User, as: "changedByUser", attributes: ["id", "email", "fullName", "role"] }],
        order: [["changedAt", "ASC"]],
      }),
      this.subjectTransferFileModel.findAll({
        where: { subjectId: id },
        order: [["createdAt", "ASC"]],
      }),
    ]);

    const transferUploadedAt = transferFiles
      .map((file) => file.createdAt)
      .filter(Boolean)
      .sort((a, b) => a.getTime() - b.getTime())
      .at(-1);
    const hasSubjectCreatedEvent = events.some((event) => event.eventType === "SUBJECT_CREATED");

    const entries: TimelineEntry[] = [
      ...events.map((event) => ({
        id: `event-${event.id}`,
        type: event.eventType,
        title: event.title,
        description: event.description,
        actor: this.timelineActor(event.actor),
        createdAt: event.createdAt,
        metadata: event.metadata ?? null,
      })),
      ...history
        .filter((item) => !(hasSubjectCreatedEvent && !item.previousStatus && item.newStatus === SubjectStatus.PENDIENTE))
        .map((item) => ({
          id: `status-${item.id}`,
          type: "STATUS_CHANGED",
          title: this.statusTimelineTitle(item.previousStatus ?? null, item.newStatus),
          description: item.observation ?? null,
          actor: this.timelineActor(item.changedByUser),
          createdAt: item.createdAt,
          metadata: {
            previousStatus: item.previousStatus ?? null,
            newStatus: item.newStatus,
          },
        })),
      ...comments.map((comment) => ({
        id: `comment-${comment.id}`,
        type: "COMMENT_ADDED",
        title: this.commentTimelineTitle(comment.commentType),
        description: comment.content,
        actor: this.timelineActor(comment.author),
        createdAt: comment.createdAt,
        metadata: {
          commentType: comment.commentType,
        },
      })),
      ...notifications.map((notification) => ({
        id: `notification-${notification.id}`,
        type: "NOTIFICATION",
        title: this.notificationTimelineTitle(notification.notificationType),
        description: `${notification.subjectLine} - ${this.notificationStatusLabel(notification.status)}`,
        actor: null,
        createdAt: notification.sentAt ?? notification.createdAt,
        metadata: {
          notificationType: notification.notificationType,
          recipientEmail: notification.recipientEmail,
          status: notification.status,
          errorMessage: notification.errorMessage ?? null,
        },
      })),
      ...auditLogs.map((log) => ({
        id: `audit-${log.id}`,
        type: "DATA_UPDATED",
        title: `Campo actualizado: ${this.fieldLabel(log.fieldName)}`,
        description: this.auditDescription(log.oldValue, log.newValue),
        actor: this.timelineActor(log.changedByUser),
        createdAt: log.changedAt,
        metadata: {
          fieldName: log.fieldName,
          oldValue: log.oldValue ?? null,
          newValue: log.newValue ?? null,
        },
      })),
    ];

    if (transferFiles.length > 0 && transferUploadedAt && !events.some((event) => event.eventType === "TRANSFER_COMPLETED")) {
      entries.push({
        id: `transfer-summary-${subject.id}`,
        type: "TRANSFER_COMPLETED",
        title: "Material copiado al Drive de revision",
        description: `${transferFiles.length} archivo(s) quedaron disponibles para revision.`,
        actor: this.timelineActor(subject.createdBy),
        createdAt: transferUploadedAt,
        metadata: {
          fileCount: transferFiles.length,
          totalBytes: transferFiles.reduce((sum, file) => sum + Number(file.sizeBytes ?? 0), 0),
        },
      });
    }

    return entries
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((entry) => ({
        ...entry,
        createdAt: entry.createdAt.toISOString(),
      }));
  }

  async files(id: number, user: AuthUser) {
    await this.findOne(id, user);
    return this.subjectTransferFileModel.findAll({
      where: { subjectId: id },
      order: [
        ["filePath", "ASC"],
        ["fileName", "ASC"],
      ],
    });
  }

  async downloadFile(id: number, fileId: number, user: AuthUser, response: Response, inline = false) {
    const subject = await this.findOne(id, user);
    const storedFile = await this.subjectTransferFileModel.findOne({
      where: { id: fileId, subjectId: id },
    });
    if (!storedFile) throw new NotFoundException("Transfer file not found");

    const download = await this.driveService.downloadById(storedFile);
    const filename = this.safeDownloadName(download.filename);

    if (inline && this.isOfficePreviewFile(filename)) {
      return this.previewOfficeAsPdf(download.stream, filename, response);
    }

    if (!inline) {
      await this.recordTimelineEvent(subject.id, "DOWNLOAD_FILE", "Archivo descargado", `${filename} fue descargado desde la plataforma.`, user.sub, {
        fileId: storedFile.id,
        fileName: filename,
        filePath: storedFile.filePath ?? [],
        sizeBytes: storedFile.sizeBytes ?? download.size ?? null,
      });
      this.logger.log(`File download started: subjectId=${id} fileId=${fileId} actorUserId=${user.sub} filename="${filename}"`);
    }

    response.setHeader("Content-Type", download.mimeType ?? storedFile.mimeType ?? "application/octet-stream");
    response.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${filename}"`);
    if (download.size) response.setHeader("Content-Length", String(download.size));
    download.stream.pipe(response);
  }

  async downloadZip(id: number, user: AuthUser, response: Response) {
    const subject = await this.findOne(id, user);
    const files = await this.subjectTransferFileModel.findAll({
      where: { subjectId: id },
      order: [
        ["filePath", "ASC"],
        ["fileName", "ASC"],
      ],
    });
    if (files.length === 0) {
      throw new BadRequestException("Review Drive folder has no downloadable files");
    }

    const archive = archiver("zip", {
      zlib: { level: 6 },
      forceZip64: true,
    });
    const filename = `${this.safeDownloadName(subject.name)}-${subject.id}.zip`;

    response.setHeader("Content-Type", "application/zip");
    response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await this.recordTimelineEvent(subject.id, "DOWNLOAD_ZIP", "Descarga masiva generada", "Se descargo un ZIP con todo el material de la solicitud.", user.sub, {
      fileCount: files.length,
      fileName: filename,
    });
    archive.on("error", (error: Error) => {
      this.logger.error(`ZIP generation failed: subjectId=${id} error=${error.message}`);
      response.destroy(error);
    });
    archive.pipe(response);

    for (const file of files) {
      const download = await this.driveService.downloadById(file);
      archive.append(download.stream, { name: this.zipPath(file, download.filename) });
    }

    this.logger.log(`ZIP download generated: subjectId=${id} fileCount=${files.length}`);
    await archive.finalize();
  }

  async addComment(id: number, dto: CreateCommentDto, user: AuthUser) {
    return this.sequelize.transaction(async (transaction) => {
      const subject = await this.subjectModel.findByPk(id, { transaction });
      if (!subject) throw new NotFoundException("Materia not found");
      this.assertCanRead(subject, user);

      await this.commentModel.create(
        {
          subjectId: id,
          authorUserId: user.sub,
          authorRole: user.role,
          commentType: dto.commentType ?? CommentType.GENERAL,
          content: dto.content,
        } as Comment,
        { transaction },
      );

      this.logger.log(`Comment added: subjectId=${id} actorUserId=${user.sub} commentType=${dto.commentType ?? CommentType.GENERAL}`);
      return this.comments(id, user);
    });
  }

  private async recordTimelineEvent(
    subjectId: number,
    eventType: string,
    title: string,
    description: string,
    actorUserId?: number,
    metadata?: Record<string, unknown>,
  ) {
    return this.subjectTimelineEventModel.create({
      subjectId,
      eventType,
      title,
      description,
      actorUserId: actorUserId ?? null,
      metadata: metadata ?? null,
    } as Partial<SubjectTimelineEvent> as SubjectTimelineEvent);
  }

  private timelineActor(user?: User | null): TimelineActor {
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
    };
  }

  private statusTimelineTitle(previousStatus: SubjectStatus | null, newStatus: SubjectStatus) {
    if (!previousStatus) return "Solicitud enviada a LMS";
    if (newStatus === SubjectStatus.REQUIERE_AJUSTES) return "Solicitud devuelta para ajustes";
    if (newStatus === SubjectStatus.PENDIENTE && previousStatus === SubjectStatus.REQUIERE_AJUSTES) {
      return "Correcciones notificadas a LMS";
    }
    if (newStatus === SubjectStatus.APROBADO) return "Solicitud aprobada";
    return "Estado actualizado";
  }

  private commentTimelineTitle(commentType: CommentType) {
    if (commentType === CommentType.DEVOLUCION) return "Observacion de ajustes registrada";
    if (commentType === CommentType.CIERRE) return "Observacion de cierre registrada";
    if (commentType === CommentType.ERROR) return "Incidencia registrada";
    return "Comentario registrado";
  }

  private notificationTimelineTitle(notificationType: string) {
    const labels: Record<string, string> = {
      SUBJECT_CREATED: "Notificacion enviada a LMS",
      SUBJECT_RETURNED: "Notificacion de ajustes enviada",
      SUBJECT_CORRECTIONS_READY: "Notificacion de correcciones enviada",
      SUBJECT_COMPLETED: "Notificacion de aprobacion enviada",
      SUBJECT_STATUS_UPDATED: "Notificacion de estado enviada",
      SUBJECT_ERROR: "Notificacion de error registrada",
    };
    return labels[notificationType] ?? "Notificacion registrada";
  }

  private notificationStatusLabel(status: string) {
    const labels: Record<string, string> = {
      PENDING: "pendiente de envio",
      SENT: "enviada",
      FAILED: "fallida",
      SKIPPED: "omitida",
    };
    return labels[status] ?? status.toLowerCase();
  }

  private fieldLabel(fieldName: string) {
    const labels: Record<string, string> = {
      name: "materia",
      semester: "semestre",
      academicLevel: "nivel academico",
      programName: "programa",
      contentDescription: "descripcion",
      driveFolderUrl: "enlace Drive",
      contentTypeCodes: "tipos de contenido",
    };
    return labels[fieldName] ?? fieldName;
  }

  private auditDescription(oldValue?: string | null, newValue?: string | null) {
    if (!oldValue && newValue) return `Nuevo valor: ${newValue}`;
    if (oldValue && !newValue) return `Valor anterior: ${oldValue}`;
    if (!oldValue && !newValue) return null;
    return `Antes: ${oldValue} | Ahora: ${newValue}`;
  }

  private buildWhere(query: QuerySubjectsDto): SubjectWhere {
    const where: SubjectWhere = { isActive: true };

    if (query.status) where.currentStatus = query.status;
    if (query.semester) where.semester = query.semester;
    if (query.academicLevel) where.academicLevel = query.academicLevel;
    if (query.programName) where.programName = query.programName;
    if (query.search) {
      where[Op.or as any] = [
        { name: { [Op.iLike]: `%${query.search}%` } },
        { programName: { [Op.iLike]: `%${query.search}%` } },
      ];
    }
    if (query.fromDate || query.toDate) {
      where.createdAt = {
        ...(query.fromDate ? { [Op.gte]: new Date(query.fromDate) } : {}),
        ...(query.toDate ? { [Op.lte]: new Date(query.toDate) } : {}),
      } as any;
    }

    return where;
  }

  private buildAuthorizedWhere(query: QuerySubjectsDto, user: AuthUser) {
    const where = this.buildWhere(query);
    if (user.role === UserRole.FABRICA) {
      where.createdByUserId = user.sub;
    }
    return where;
  }

  private startOfToday() {
    return literal("date_trunc('day', now())");
  }

  private defaultInclude() {
    return [
      { model: User, as: "createdBy", attributes: ["id", "email", "fullName", "role"] },
      { model: User, as: "assignedLmsUser", attributes: ["id", "email", "fullName", "role"] },
      { model: ContentType, as: "contentTypes", through: { attributes: [] } },
      {
        model: Comment,
        as: "comments",
        attributes: ["id", "commentType", "content", "createdAt"],
        include: [{ model: User, as: "author", attributes: ["id", "email", "fullName", "role"] }],
      },
    ];
  }

  private async resolveContentTypes(codes: ContentTypeCode[], transaction?: Transaction) {
    const contentTypes = await this.contentTypeModel.findAll({
      where: { code: { [Op.in]: codes }, isActive: true },
      transaction,
    });

    if (contentTypes.length !== new Set(codes).size) {
      throw new BadRequestException("One or more content types are invalid");
    }

    return contentTypes;
  }

  private async assertActiveSemester(code: string, transaction?: Transaction) {
    const semester = await this.semesterModel.findOne({
      where: { code, isActive: true },
      transaction,
    });

    if (!semester) {
      throw new BadRequestException("Semester is invalid or inactive");
    }
  }

  private async assertActiveProgram(name: string, transaction?: Transaction) {
    const program = await this.programModel.findOne({
      where: { name, isActive: true },
      transaction,
    });

    if (!program) {
      throw new BadRequestException("Program is invalid or inactive");
    }
  }

  private async getUserOrFail(id: number, transaction?: Transaction) {
    const user = await this.userModel.findByPk(id, { transaction });
    if (!user) throw new NotFoundException("User not found");
    return user;
  }

  private assertCanRead(subject: Subject, user: AuthUser) {
    if (user.role === UserRole.FABRICA && subject.createdByUserId !== user.sub) {
      throw new ForbiddenException("Fabrica users can only read their own materias");
    }
  }

  private assertCanEditBaseData(subject: Subject, user: AuthUser) {
    if (subject.currentStatus === SubjectStatus.APROBADO) {
      throw new BadRequestException("Approved materias cannot be edited in critical fields");
    }

    if (user.role === UserRole.ADMIN) return;

    if (user.role !== UserRole.FABRICA || subject.createdByUserId !== user.sub) {
      throw new ForbiddenException("Only the creator from Fabrica can edit base data");
    }

    const editableStatuses = [
      SubjectStatus.PENDIENTE,
      SubjectStatus.REQUIERE_AJUSTES,
    ];
    if (!editableStatuses.includes(subject.currentStatus)) {
      throw new BadRequestException("Materia cannot be edited in the current status");
    }
  }

  private assertStatusPermission(subject: Subject, newStatus: SubjectStatus, user: AuthUser) {
    if (user.role === UserRole.ADMIN) return;

    if (user.role === UserRole.FABRICA) {
      const canResendOwnReturned =
        subject.createdByUserId === user.sub &&
        subject.currentStatus === SubjectStatus.REQUIERE_AJUSTES &&
        newStatus === SubjectStatus.PENDIENTE;

      if (!canResendOwnReturned) {
        throw new ForbiddenException("Fabrica can only resend returned materias");
      }
      return;
    }

    if (user.role !== UserRole.LMS) {
      throw new ForbiddenException("Only LMS or Admin can update this status");
    }

    if (newStatus === SubjectStatus.PENDIENTE) {
      throw new ForbiddenException("LMS cannot move a materia back to initial statuses");
    }
  }

  private assertValidTransition(current: SubjectStatus, next: SubjectStatus) {
    if (current === next) return;
    const allowed = VALID_TRANSITIONS[current] ?? [];
    if (!allowed.includes(next)) {
      throw new BadRequestException(`Invalid status transition from ${current} to ${next}`);
    }
  }

  private commentTypeForStatus(status: SubjectStatus) {
    if (status === SubjectStatus.REQUIERE_AJUSTES) return CommentType.DEVOLUCION;
    if (status === SubjectStatus.APROBADO) return CommentType.CIERRE;
    return CommentType.GENERAL;
  }

  private async rollbackFailedCreate(subjectId: number) {
    await this.sequelize.transaction(async (transaction) => {
      await this.commentModel.destroy({ where: { subjectId }, transaction });
      await this.statusHistoryModel.destroy({ where: { subjectId }, transaction });
      await this.subjectTransferFileModel.destroy({ where: { subjectId }, transaction });
      await this.subjectContentTypeModel.destroy({ where: { subjectId }, transaction });
      await this.subjectModel.destroy({ where: { id: subjectId }, transaction });
    });
    this.logger.warn(`Materia creation rolled back after transfer failure: subjectId=${subjectId}`);
  }

  private zipPath(file: Pick<SubjectTransferFile, "filePath">, filename: string) {
    return [...(file.filePath ?? []), filename].map((part) => this.safeZipSegment(part)).join("/");
  }

  private safeZipSegment(value: string) {
    return value
      .replace(/[<>:"\\|?*\u0000-\u001F]/g, "-")
      .replace(/\.\.+/g, ".")
      .trim() || "archivo";
  }

  private safeDownloadName(value: string) {
    return this.safeZipSegment(value).replace(/[/]/g, "-");
  }

  private isOfficePreviewFile(filename: string) {
    return OFFICE_PREVIEW_EXTENSIONS.has(extname(filename).toLowerCase());
  }

  private async previewOfficeAsPdf(stream: NodeJS.ReadableStream, filename: string, response: Response) {
    const workDir = await mkdtemp(join(tmpdir(), "carga-lms-preview-"));
    const inputDir = join(workDir, "input");
    const outputDir = join(workDir, "output");
    await mkdir(inputDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });

    const inputPath = join(inputDir, filename);
    await pipeline(stream, createWriteStream(inputPath));

    try {
      await execFileAsync(this.resolveLibreOfficeBinary(), [
        "--headless",
        "--nologo",
        "--nofirststartwizard",
        "--convert-to",
        "pdf",
        "--outdir",
        outputDir,
        inputPath,
      ]);
    } catch (error) {
      await rm(workDir, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Office preview conversion failed: filename="${filename}" error=${message}`);
      if (message.includes("ENOENT")) {
        throw new BadRequestException(
          "LibreOffice no esta instalado o no esta disponible en PATH. Instala LibreOffice o configura LIBREOFFICE_BIN para generar vistas previas Office.",
        );
      }
      throw new BadRequestException("No fue posible generar la vista previa PDF de este archivo Office.");
    }

    const outputFiles = await readdir(outputDir);
    const pdfFile = outputFiles.find((file) => file.toLowerCase().endsWith(".pdf"));
    if (!pdfFile) {
      await rm(workDir, { recursive: true, force: true });
      throw new BadRequestException("No fue posible generar la vista previa PDF de este archivo Office.");
    }

    const pdfName = `${basename(filename, extname(filename))}.pdf`;
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", `inline; filename="${this.safeDownloadName(pdfName)}"`);
    response.on("finish", () => {
      void rm(workDir, { recursive: true, force: true });
    });
    response.sendFile(join(outputDir, pdfFile), (error) => {
      if (error) {
        void rm(workDir, { recursive: true, force: true });
      }
    });
  }

  private resolveLibreOfficeBinary() {
    const configured = process.env.LIBREOFFICE_BIN?.trim();
    if (configured) return configured;

    const windowsCandidates = [
      "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
      "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    ];
    const windowsBinary = windowsCandidates.find((candidate) => existsSync(candidate));
    return windowsBinary ?? "soffice";
  }
}
