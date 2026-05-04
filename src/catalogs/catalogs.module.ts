import { Module } from "@nestjs/common";
import { SequelizeModule } from "@nestjs/sequelize";
import { CatalogsController } from "@/catalogs/catalogs.controller";
import { CatalogsService } from "@/catalogs/catalogs.service";
import { ContentType } from "@/catalogs/models/content-type.model";
import { Program } from "@/catalogs/models/program.model";
import { Semester } from "@/catalogs/models/semester.model";

@Module({
  imports: [SequelizeModule.forFeature([ContentType, Program, Semester])],
  controllers: [CatalogsController],
  providers: [CatalogsService],
  exports: [CatalogsService],
})
export class CatalogsModule {}
