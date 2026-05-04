import { IsEnum, IsOptional, IsString, MinLength } from "class-validator";
import { CommentType } from "@/common/enums/comment-type.enum";

export class CreateCommentDto {
  @IsOptional()
  @IsEnum(CommentType)
  commentType?: CommentType;

  @IsString()
  @MinLength(3)
  content: string;
}
