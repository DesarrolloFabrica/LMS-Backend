import { AutoIncrement, BelongsTo, Column, DataType, ForeignKey, Model, PrimaryKey, Table } from "sequelize-typescript";
import { Subject } from "@/materias/models/subject.model";
import { User } from "@/users/models/user.model";

@Table({ tableName: "subject_timeline_events", underscored: true, timestamps: false })
export class SubjectTimelineEvent extends Model<SubjectTimelineEvent> {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @ForeignKey(() => Subject)
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare subjectId: number;

  @BelongsTo(() => Subject)
  declare subject?: Subject;

  @Column({ type: DataType.STRING(80), allowNull: false })
  declare eventType: string;

  @Column({ type: DataType.STRING(180), allowNull: false })
  declare title: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description?: string | null;

  @ForeignKey(() => User)
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare actorUserId?: number | null;

  @BelongsTo(() => User, "actorUserId")
  declare actor?: User;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare metadata?: Record<string, unknown> | null;

  @Column({ field: "created_at", type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
  declare createdAt: Date;
}
