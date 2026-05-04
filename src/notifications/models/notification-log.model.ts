import { AutoIncrement, BelongsTo, Column, DataType, ForeignKey, Model, PrimaryKey, Table } from "sequelize-typescript";
import { NotificationStatus } from "@/common/enums/notification-status.enum";
import { NotificationType } from "@/common/enums/notification-type.enum";
import { Subject } from "@/materias/models/subject.model";

@Table({ tableName: "notification_logs", underscored: true, timestamps: false })
export class NotificationLog extends Model<NotificationLog> {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @ForeignKey(() => Subject)
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare subjectId?: number | null;

  @BelongsTo(() => Subject)
  declare subject?: Subject;

  @Column({ type: DataType.STRING(60), allowNull: false })
  declare notificationType: NotificationType;

  @Column({ type: DataType.STRING(255), allowNull: false })
  declare recipientEmail: string;

  @Column({ type: DataType.STRING(255), allowNull: false })
  declare subjectLine: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare bodySnapshot: string;

  @Column({ type: DataType.STRING(40), allowNull: false })
  declare status: NotificationStatus;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare errorMessage?: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare sentAt?: Date | null;

  @Column({ field: "created_at", type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
  declare createdAt: Date;
}
