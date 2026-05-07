import { IsEnum, IsInt, IsOptional, IsPositive, IsString, IsUrl, MinLength, ValidateIf } from "class-validator";
import { SubjectStatus } from "@/common/enums/subject-status.enum";

export class UpdateSubjectStatusDto {
  @IsEnum(SubjectStatus)
  newStatus: SubjectStatus;

  @ValidateIf((dto: UpdateSubjectStatusDto) => dto.newStatus === SubjectStatus.REQUIERE_AJUSTES)
  @IsString()
  @MinLength(5)
  observation?: string;

  @IsOptional()
  @IsString()
  @IsUrl({ require_protocol: true, require_tld: false })
  cdigitalUrl?: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  assignedLmsUserId?: number;
}
