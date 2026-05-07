import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { AuthUser } from "@/auth/types/auth-user.type";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { Roles } from "@/common/decorators/roles.decorator";
import { UserRole } from "@/common/enums/user-role.enum";
import { JwtAuthGuard } from "@/common/guards/jwt-auth.guard";
import { RolesGuard } from "@/common/guards/roles.guard";
import { CreateCommentDto } from "@/materias/dto/create-comment.dto";
import { CreateSubjectDto } from "@/materias/dto/create-subject.dto";
import { QuerySubjectsDto } from "@/materias/dto/query-subjects.dto";
import { UpdateSubjectDto } from "@/materias/dto/update-subject.dto";
import { UpdateSubjectStatusDto } from "@/materias/dto/update-subject-status.dto";
import { MateriasService } from "@/materias/materias.service";

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("materias")
export class MateriasController {
  constructor(private readonly materiasService: MateriasService) {}

  @Roles(UserRole.FABRICA, UserRole.ADMIN)
  @Post()
  create(@Body() dto: CreateSubjectDto, @CurrentUser() user: AuthUser) {
    return this.materiasService.create(dto, user);
  }

  @Roles(UserRole.FABRICA, UserRole.LMS, UserRole.ADMIN)
  @Get()
  findAll(@Query() query: QuerySubjectsDto, @CurrentUser() user: AuthUser) {
    return this.materiasService.findAll(query, user);
  }

  @Roles(UserRole.FABRICA, UserRole.LMS, UserRole.ADMIN)
  @Get("metrics")
  metrics(@Query() query: QuerySubjectsDto, @CurrentUser() user: AuthUser) {
    return this.materiasService.metrics(query, user);
  }

  @Roles(UserRole.FABRICA, UserRole.LMS, UserRole.ADMIN)
  @Get("activity")
  activity(@Query() query: QuerySubjectsDto, @CurrentUser() user: AuthUser) {
    return this.materiasService.activity(query, user);
  }

  @Roles(UserRole.FABRICA, UserRole.LMS, UserRole.ADMIN)
  @Get("transfers/:transferId/progress")
  transferProgress(@Param("transferId") transferId: string) {
    return this.materiasService.transferProgress(transferId);
  }

  @Roles(UserRole.FABRICA, UserRole.ADMIN)
  @Get("fabrica/mine")
  mine(@Query() query: QuerySubjectsDto, @CurrentUser() user: AuthUser) {
    return this.materiasService.findMine(query, user);
  }

  @Roles(UserRole.LMS, UserRole.ADMIN)
  @Get("lms/inbox")
  lmsInbox(@Query() query: QuerySubjectsDto) {
    return this.materiasService.findLmsInbox(query);
  }

  @Roles(UserRole.LMS, UserRole.ADMIN)
  @Get("lms/completed")
  lmsCompleted(@Query() query: QuerySubjectsDto) {
    return this.materiasService.findLmsCompleted(query);
  }

  @Roles(UserRole.LMS, UserRole.ADMIN)
  @Get("lms/upload-history")
  uploadHistory(@Query() query: QuerySubjectsDto, @CurrentUser() user: AuthUser) {
    return this.materiasService.uploadHistory(query, user);
  }

  @Roles(UserRole.FABRICA, UserRole.LMS, UserRole.ADMIN)
  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.materiasService.findOne(id, user);
  }

  @Roles(UserRole.FABRICA, UserRole.ADMIN)
  @Patch(":id")
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateSubjectDto, @CurrentUser() user: AuthUser) {
    return this.materiasService.update(id, dto, user);
  }

  @Roles(UserRole.FABRICA, UserRole.LMS, UserRole.ADMIN)
  @Patch(":id/status")
  updateStatus(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateSubjectStatusDto, @CurrentUser() user: AuthUser) {
    return this.materiasService.updateStatus(id, dto, user);
  }

  @Roles(UserRole.FABRICA, UserRole.LMS, UserRole.ADMIN)
  @Get(":id/history")
  history(@Param("id", ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.materiasService.history(id, user);
  }

  @Roles(UserRole.FABRICA, UserRole.LMS, UserRole.ADMIN)
  @Get(":id/comments")
  comments(@Param("id", ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.materiasService.comments(id, user);
  }

  @Roles(UserRole.FABRICA, UserRole.LMS, UserRole.ADMIN)
  @Get(":id/files")
  files(@Param("id", ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.materiasService.files(id, user);
  }

  @Roles(UserRole.FABRICA, UserRole.LMS, UserRole.ADMIN)
  @Get(":id/files/:fileId/download")
  downloadFile(
    @Param("id", ParseIntPipe) id: number,
    @Param("fileId", ParseIntPipe) fileId: number,
    @Query("inline") inline: string | undefined,
    @CurrentUser() user: AuthUser,
    @Res() response: Response,
  ) {
    return this.materiasService.downloadFile(id, fileId, user, response, inline === "true");
  }

  @Roles(UserRole.FABRICA, UserRole.LMS, UserRole.ADMIN)
  @Get(":id/download.zip")
  downloadZip(@Param("id", ParseIntPipe) id: number, @CurrentUser() user: AuthUser, @Res() response: Response) {
    return this.materiasService.downloadZip(id, user, response);
  }

  @Roles(UserRole.FABRICA, UserRole.LMS, UserRole.ADMIN)
  @Post(":id/comments")
  addComment(@Param("id", ParseIntPipe) id: number, @Body() dto: CreateCommentDto, @CurrentUser() user: AuthUser) {
    return this.materiasService.addComment(id, dto, user);
  }
}
