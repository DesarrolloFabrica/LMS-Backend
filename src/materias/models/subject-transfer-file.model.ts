import { AutoIncrement, BelongsTo, Column, DataType, ForeignKey, Model, PrimaryKey, Table } from "sequelize-typescript";
import { Subject } from "@/materias/models/subject.model";

@Table({ tableName: "subject_transfer_files", underscored: true, timestamps: false })
export class SubjectTransferFile extends Model<SubjectTransferFile> {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @ForeignKey(() => Subject)
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare subjectId: number;

  @BelongsTo(() => Subject)
  declare subject?: Subject;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare fileName: string;

  @Column({ type: DataType.ARRAY(DataType.TEXT), allowNull: false, defaultValue: [] })
  declare filePath: string[];

  @Column({ type: DataType.TEXT, allowNull: true })
  declare driveFileId?: string | null;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare driveUrl: string;

  @Column({ type: DataType.BIGINT, allowNull: true })
  declare sizeBytes?: number | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare mimeType?: string | null;

  @Column({ field: "created_at", type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
  declare createdAt: Date;
}
