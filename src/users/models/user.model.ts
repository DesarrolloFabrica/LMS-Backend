import { AutoIncrement, Column, CreatedAt, DataType, HasMany, Model, PrimaryKey, Table, UpdatedAt } from "sequelize-typescript";
import { UserRole } from "@/common/enums/user-role.enum";
import { Subject } from "@/materias/models/subject.model";

@Table({ tableName: "users", underscored: true, timestamps: true })
export class User extends Model<User> {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @Column({ type: DataType.STRING(255), allowNull: false, unique: true })
  declare googleSub: string;

  @Column({ type: DataType.STRING(255), allowNull: false, unique: true })
  declare email: string;

  @Column({ type: DataType.STRING(160), allowNull: false })
  declare fullName: string;

  @Column({ type: DataType.STRING(30), allowNull: false, defaultValue: UserRole.FABRICA })
  declare role: UserRole;

  @Column({ type: DataType.STRING(120), allowNull: true })
  declare area?: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare avatarUrl?: string | null;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare isActive: boolean;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;

  @HasMany(() => Subject, "createdByUserId")
  declare createdSubjects?: Subject[];
}
