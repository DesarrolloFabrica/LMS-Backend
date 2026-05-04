import { AutoIncrement, BelongsToMany, Column, CreatedAt, DataType, Model, PrimaryKey, Table, UpdatedAt } from "sequelize-typescript";
import { ContentTypeCode } from "@/common/enums/content-type-code.enum";
import { SubjectContentType } from "@/materias/models/subject-content-type.model";
import { Subject } from "@/materias/models/subject.model";

@Table({ tableName: "content_types", underscored: true, timestamps: true })
export class ContentType extends Model<ContentType> {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @Column({ type: DataType.STRING(60), allowNull: false, unique: true })
  declare code: ContentTypeCode;

  @Column({ type: DataType.STRING(120), allowNull: false })
  declare name: string;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare isActive: boolean;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;

  @BelongsToMany(() => Subject, () => SubjectContentType)
  declare subjects?: Subject[];
}
