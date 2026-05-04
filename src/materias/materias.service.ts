import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { col, fn, literal, Op, Transaction, WhereOptions } from "sequelize";
import { Sequelize } from "sequelize-typescript";
import { AuditService, FieldChange } from "@/audit/audit.service";
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
import { Subject } from "@/materias/models/subject.model";
import { NotificationsService } from "@/notifications/notifications.service";
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

@Injectable()
export class MateriasService {
  constructor(
    private readonly sequelize: Sequelize,
    @InjectModel(Subject) private readonly subjectModel: typeof Subject,
    @InjectModel(ContentType) private readonly contentTypeModel: typeof ContentType,
    @InjectModel(Program) private readonly programModel: typeof Program,
    @InjectModel(Semester) private readonly semesterModel: typeof Semester,
    @InjectModel(StatusHistory) private readonly statusHistoryModel: typeof StatusHistory,
    @InjectModel(Comment) private readonly commentModel: typeof Comment,
    @InjectModel(User) private readonly userModel: typeof User,
    private readonly notificationsService: NotificationsService,
    private readonly auditService: AuditService,
  ) {}

  async create(dto: CreateSubjectDto, user: AuthUser) {
    if (user.role !== UserRole.FABRICA && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException("Only Fabrica or Admin can create materias");
    }

    return this.sequelize.transaction(async (transaction) => {
      const actor = await this.getUserOrFail(user.sub, transaction);
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
      await this.notificationsService.logSubjectCreated(subject, actor, transaction);

      return this.findOne(subject.id, user, transaction);
    });
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
        const cdigitalUrl = dto.cdigitalUrl?.trim();
        if (!cdigitalUrl) {
          throw new BadRequestException("C Digital URL is required to approve the subject");
        }
        patch.cdigitalUrl = cdigitalUrl;
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

      return this.comments(id, user);
    });
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
}
