import { Module } from "@nestjs/common";
import { SequelizeModule } from "@nestjs/sequelize";
import { AuditService } from "@/audit/audit.service";
import { AuditLog } from "@/audit/models/audit-log.model";

@Module({
  imports: [SequelizeModule.forFeature([AuditLog])],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
