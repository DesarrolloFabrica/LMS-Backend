import { AutoIncrement, BelongsTo, Column, DataType, ForeignKey, Model, PrimaryKey, Table } from "sequelize-typescript";
import { CommentType } from "@/common/enums/comment-type.enum";
import { UserRole } from "@/common/enums/user-role.enum";
import { Subject } from "@/materias/models/subject.model";
import { User } from "@/users/models/user.model";

@Table({ tableName: "comments", underscored: true, timestamps: false })
export class Comment extends Model<Comment> {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @ForeignKey(() => Subject)
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare subjectId: number;

  @BelongsTo(() => Subject)
  declare subject?: Subject;

  @ForeignKey(() => User)
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare authorUserId: number;

  @BelongsTo(() => User)
  declare author?: User;

  @Column({ type: DataType.STRING(30), allowNull: false })
  declare authorRole: UserRole;

  @Column({ type: DataType.STRING(40), allowNull: false, defaultValue: CommentType.GENERAL })
  declare commentType: CommentType;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare content: string;

  @Column({ field: "created_at", type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
  declare createdAt: Date;
}
