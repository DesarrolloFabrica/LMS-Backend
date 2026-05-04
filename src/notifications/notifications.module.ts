import { Module } from "@nestjs/common";
import { SequelizeModule } from "@nestjs/sequelize";
import { NotificationLog } from "@/notifications/models/notification-log.model";
import { NotificationsService } from "@/notifications/notifications.service";

@Module({
  imports: [SequelizeModule.forFeature([NotificationLog])],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
