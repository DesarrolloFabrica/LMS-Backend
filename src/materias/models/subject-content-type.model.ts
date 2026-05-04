import { AutoIncrement, Column, DataType, ForeignKey, Model, PrimaryKey, Table } from "sequelize-typescript";
import { ContentType } from "@/catalogs/models/content-type.model";
import { Subject } from "@/materias/models/subject.model";

@Table({ tableName: "subject_content_types", underscored: true, timestamps: false })
export class SubjectContentType extends Model<SubjectContentType> {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @ForeignKey(() => Subject)
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare subjectId: number;

  @ForeignKey(() => ContentType)
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare contentTypeId: number;

  @Column({ field: "created_at", type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
  declare createdAt: Date;
}
