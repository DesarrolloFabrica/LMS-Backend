import { AutoIncrement, Column, CreatedAt, DataType, HasMany, Model, PrimaryKey, Table, UpdatedAt } from "sequelize-typescript";
import { Subject } from "@/materias/models/subject.model";

@Table({ tableName: "programs", underscored: true, timestamps: true })
export class Program extends Model<Program> {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @Column({ type: DataType.STRING(80), allowNull: false, unique: true })
  declare code: string;

  @Column({ type: DataType.STRING(180), allowNull: false, unique: true })
  declare name: string;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare sortOrder: number;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare isActive: boolean;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;

  @HasMany(() => Subject, { foreignKey: "programName", sourceKey: "name" })
  declare subjects?: Subject[];
}
