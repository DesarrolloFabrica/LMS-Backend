import { AutoIncrement, BelongsTo, Column, DataType, Default, ForeignKey, Model, PrimaryKey, Table } from "sequelize-typescript";
import { Subject } from "@/materias/models/subject.model";
import { User } from "@/users/models/user.model";

@Table({ tableName: "audit_logs", underscored: true, timestamps: false })
export class AuditLog extends Model<AuditLog> {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @ForeignKey(() => Subject)
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare subjectId?: number | null;

  @BelongsTo(() => Subject)
  declare subject?: Subject;

  @Column({ type: DataType.STRING(120), allowNull: false })
  declare fieldName: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare oldValue?: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare newValue?: string | null;

  @ForeignKey(() => User)
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare changedByUserId: number;

  @BelongsTo(() => User)
  declare changedByUser?: User;

  @Default(DataType.NOW)
  @Column({ type: DataType.DATE, allowNull: false })
  declare changedAt: Date;
}
