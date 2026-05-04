import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { SequelizeModule } from "@nestjs/sequelize";
import configuration from "@/config/configuration";
import { CommonModule } from "@/common/common.module";
import { AcademicLevel } from "@/common/enums/academic-level.enum";
import { CommentType } from "@/common/enums/comment-type.enum";
import { ContentTypeCode } from "@/common/enums/content-type-code.enum";
import { NotificationStatus } from "@/common/enums/notification-status.enum";
import { NotificationType } from "@/common/enums/notification-type.enum";
import { SubjectStatus } from "@/common/enums/subject-status.enum";
import { UserRole } from "@/common/enums/user-role.enum";
import { AuditModule } from "@/audit/audit.module";
import { AuditLog } from "@/audit/models/audit-log.model";
import { AuthModule } from "@/auth/auth.module";
import { ContentType } from "@/catalogs/models/content-type.model";
import { Program } from "@/catalogs/models/program.model";
import { Semester } from "@/catalogs/models/semester.model";
import { CatalogsModule } from "@/catalogs/catalogs.module";
import { HealthModule } from "@/health/health.module";
import { Comment } from "@/materias/models/comment.model";
import { StatusHistory } from "@/materias/models/status-history.model";
import { SubjectContentType } from "@/materias/models/subject-content-type.model";
import { Subject } from "@/materias/models/subject.model";
import { MateriasModule } from "@/materias/materias.module";
import { NotificationLog } from "@/notifications/models/notification-log.model";
import { NotificationsModule } from "@/notifications/notifications.module";
import { User } from "@/users/models/user.model";
import { UsersModule } from "@/users/users.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: [".env"],
    }),
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>("jwt.secret") ?? "change_me",
        signOptions: { expiresIn: (config.get<string>("jwt.expiresIn") ?? "4h") as never },
      }),
    }),
    SequelizeModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        dialect: "postgres",
        host: config.get<string>("database.host"),
        port: config.get<number>("database.port"),
        database: config.get<string>("database.name"),
        username: config.get<string>("database.user"),
        password: config.get<string>("database.password"),
        autoLoadModels: true,
        synchronize: config.get<boolean>("database.sync") ?? false,
        logging: config.get<boolean>("database.logging") ? console.log : false,
        dialectOptions: config.get<boolean>("database.ssl")
          ? { ssl: { require: true, rejectUnauthorized: false } }
          : undefined,
        models: [User, Subject, ContentType, Program, Semester, SubjectContentType, StatusHistory, Comment, NotificationLog, AuditLog],
        define: {
          underscored: true,
        },
      }),
    }),
    CommonModule,
    UsersModule,
    AuthModule,
    CatalogsModule,
    MateriasModule,
    NotificationsModule,
    AuditModule,
    HealthModule,
  ],
})
export class AppModule {
  readonly enums = {
    AcademicLevel,
    CommentType,
    ContentTypeCode,
    NotificationStatus,
    NotificationType,
    SubjectStatus,
    UserRole,
  };
}
