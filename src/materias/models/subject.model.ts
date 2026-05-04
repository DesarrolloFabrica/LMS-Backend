import {
  AutoIncrement,
  BelongsTo,
  BelongsToMany,
  Column,
  CreatedAt,
  DataType,
  ForeignKey,
  HasMany,
  Model,
  PrimaryKey,
  Table,
  UpdatedAt,
} from "sequelize-typescript";
import { AcademicLevel } from "@/common/enums/academic-level.enum";
import { SubjectStatus } from "@/common/enums/subject-status.enum";
import { ContentType } from "@/catalogs/models/content-type.model";
import { Program } from "@/catalogs/models/program.model";
import { Semester } from "@/catalogs/models/semester.model";
import { AuditLog } from "@/audit/models/audit-log.model";
import { Comment } from "@/materias/models/comment.model";
import { StatusHistory } from "@/materias/models/status-history.model";
import { SubjectContentType } from "@/materias/models/subject-content-type.model";
import { User } from "@/users/models/user.model";

@Table({ tableName: "materias", underscored: true, timestamps: true })
export class Subject extends Model<Subject> {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @Column({ type: DataType.STRING(220), allowNull: false })
  declare name: string;

  @ForeignKey(() => Semester)
  @Column({ type: DataType.STRING(40), allowNull: false })
  declare semester: string;

  @BelongsTo(() => Semester, { foreignKey: "semester", targetKey: "code" })
  declare semesterCatalog?: Semester;

  @Column({ type: DataType.STRING(40), allowNull: false })
  declare academicLevel: AcademicLevel;

  @ForeignKey(() => Program)
  @Column({ type: DataType.STRING(180), allowNull: false })
  declare programName: string;

  @BelongsTo(() => Program, { foreignKey: "programName", targetKey: "name" })
  declare program?: Program;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare contentDescription: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare driveFolderUrl: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare cdigitalUrl?: string | null;

  @Column({
    type: DataType.STRING(60),
    allowNull: false,
    defaultValue: SubjectStatus.PENDIENTE,
  })
  declare currentStatus: SubjectStatus;

  @ForeignKey(() => User)
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare createdByUserId: number;

  @BelongsTo(() => User, "createdByUserId")
  declare createdBy?: User;

  @ForeignKey(() => User)
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare assignedLmsUserId?: number | null;

  @BelongsTo(() => User, "assignedLmsUserId")
  declare assignedLmsUser?: User;

  @Column({ type: DataType.DATE, allowNull: true })
  declare reviewedAt?: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare completedAt?: Date | null;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare isActive: boolean;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;

  @BelongsToMany(() => ContentType, () => SubjectContentType)
  declare contentTypes?: ContentType[];

  @HasMany(() => StatusHistory)
  declare history?: StatusHistory[];

  @HasMany(() => Comment)
  declare comments?: Comment[];

  @HasMany(() => AuditLog)
  declare auditLogs?: AuditLog[];
}
