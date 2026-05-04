import { IsArray, IsEnum, IsOptional, IsString, IsUrl, MaxLength, MinLength } from "class-validator";
import { AcademicLevel } from "@/common/enums/academic-level.enum";
import { ContentTypeCode } from "@/common/enums/content-type-code.enum";

export class UpdateSubjectDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(220)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  semester?: string;

  @IsOptional()
  @IsEnum(AcademicLevel)
  academicLevel?: AcademicLevel;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(180)
  programName?: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  contentDescription?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  driveFolderUrl?: string;

  @IsOptional()
  @IsArray()
  @IsEnum(ContentTypeCode, { each: true })
  contentTypeCodes?: ContentTypeCode[];
}
