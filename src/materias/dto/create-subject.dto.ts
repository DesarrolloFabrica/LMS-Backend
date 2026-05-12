import { ArrayMinSize, IsArray, IsEnum, IsOptional, IsString, IsUrl, IsUUID, MaxLength, MinLength } from "class-validator";
import { AcademicLevel } from "@/common/enums/academic-level.enum";
import { ContentTypeCode } from "@/common/enums/content-type-code.enum";

export class CreateSubjectDto {
  @IsString()
  @MinLength(2)
  @MaxLength(220)
  name: string;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  semester: string;

  @IsEnum(AcademicLevel)
  academicLevel: AcademicLevel;

  @IsString()
  @MinLength(1)
  @MaxLength(180)
  programName: string;

  @IsString()
  @MinLength(10)
  contentDescription: string;

  @IsUrl({ require_protocol: true })
  driveFolderUrl: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(ContentTypeCode, { each: true })
  contentTypeCodes: ContentTypeCode[];

  @IsOptional()
  @IsUUID()
  transferId?: string;
}
