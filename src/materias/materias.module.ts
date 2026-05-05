import { Module } from "@nestjs/common";
import { SequelizeModule } from "@nestjs/sequelize";
import { AuditModule } from "@/audit/audit.module";
import { ContentType } from "@/catalogs/models/content-type.model";
import { Program } from "@/catalogs/models/program.model";
import { Semester } from "@/catalogs/models/semester.model";
import { GoogleDriveImportModule } from "@/integrations/google-drive/google-drive-import.module";
import { MegaModule } from "@/integrations/mega/mega.module";
import { Comment } from "@/materias/models/comment.model";
import { StatusHistory } from "@/materias/models/status-history.model";
import { SubjectContentType } from "@/materias/models/subject-content-type.model";
import { Subject } from "@/materias/models/subject.model";
import { MateriasController } from "@/materias/materias.controller";
import { MateriasService } from "@/materias/materias.service";
import { NotificationsModule } from "@/notifications/notifications.module";
import { User } from "@/users/models/user.model";
import { UsersModule } from "@/users/users.module";

@Module({
  imports: [
    SequelizeModule.forFeature([Subject, ContentType, Program, Semester, SubjectContentType, StatusHistory, Comment, User]),
    UsersModule,
    NotificationsModule,
    AuditModule,
    GoogleDriveImportModule,
    MegaModule,
  ],
  controllers: [MateriasController],
  providers: [MateriasService],
  exports: [MateriasService],
})
export class MateriasModule {}
