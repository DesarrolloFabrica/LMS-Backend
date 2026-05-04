import { AutoIncrement, BelongsTo, Column, DataType, ForeignKey, Model, PrimaryKey, Table } from "sequelize-typescript";
import { SubjectStatus } from "@/common/enums/subject-status.enum";
import { Subject } from "@/materias/models/subject.model";
import { User } from "@/users/models/user.model";

@Table({ tableName: "status_history", underscored: true, timestamps: false })
export class StatusHistory extends Model<StatusHistory> {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @ForeignKey(() => Subject)
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare subjectId: number;

  @BelongsTo(() => Subject)
  declare subject?: Subject;

  @Column({ type: DataType.STRING(60), allowNull: true })
  declare previousStatus?: SubjectStatus | null;

  @Column({ type: DataType.STRING(60), allowNull: false })
  declare newStatus: SubjectStatus;

  @ForeignKey(() => User)
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare changedByUserId: number;

  @BelongsTo(() => User)
  declare changedByUser?: User;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare observation?: string | null;

  @Column({ field: "created_at", type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
  declare createdAt: Date;
}
