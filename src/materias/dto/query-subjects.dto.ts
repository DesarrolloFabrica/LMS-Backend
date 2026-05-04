import { IsDateString, IsEnum, IsOptional, IsString } from "class-validator";
import { AcademicLevel } from "@/common/enums/academic-level.enum";
import { SubjectStatus } from "@/common/enums/subject-status.enum";

export class QuerySubjectsDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(SubjectStatus)
  status?: SubjectStatus;

  @IsOptional()
  @IsString()
  semester?: string;

  @IsOptional()
  @IsEnum(AcademicLevel)
  academicLevel?: AcademicLevel;

  @IsOptional()
  @IsString()
  programName?: string;

  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;
}
