import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { AcademicLevel } from "@/common/enums/academic-level.enum";
import { SubjectStatus } from "@/common/enums/subject-status.enum";
import { ContentType } from "@/catalogs/models/content-type.model";
import { Program } from "@/catalogs/models/program.model";
import { Semester } from "@/catalogs/models/semester.model";


const SUBJECT_STATUS_LABELS: Record<SubjectStatus, string> = {
  [SubjectStatus.PENDIENTE]: "PENDIENTE",
  [SubjectStatus.APROBADO]: "APROBADO",
  [SubjectStatus.REQUIERE_AJUSTES]: "REQUIERE AJUSTES",
};

@Injectable()
export class CatalogsService {
  constructor(
    @InjectModel(ContentType) private readonly contentTypeModel: typeof ContentType,
    @InjectModel(Program) private readonly programModel: typeof Program,
    @InjectModel(Semester) private readonly semesterModel: typeof Semester,
  ) {}

  academicLevels() {
    return Object.values(AcademicLevel).map((code) => ({ code, name: this.titleize(code) }));
  }

  statuses() {
    return Object.values(SubjectStatus).map((code) => ({ code, name: SUBJECT_STATUS_LABELS[code] }));
  }

  async contentTypes() {
    return this.contentTypeModel.findAll({
      where: { isActive: true },
      order: [["name", "ASC"]],
    });
  }

  async semesters() {
    return this.semesterModel.findAll({
      where: { isActive: true },
      order: [["sortOrder", "ASC"]],
    });
  }

  async programs() {
    return this.programModel.findAll({
      where: { isActive: true },
      order: [["sortOrder", "ASC"]],
    });
  }

  private titleize(value: string) {
    return value
      .toLowerCase()
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }
}


