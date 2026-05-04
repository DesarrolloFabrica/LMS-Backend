import { Controller, Get, UseGuards } from "@nestjs/common";
import { CatalogsService } from "@/catalogs/catalogs.service";
import { JwtAuthGuard } from "@/common/guards/jwt-auth.guard";

@UseGuards(JwtAuthGuard)
@Controller("catalogs")
export class CatalogsController {
  constructor(private readonly catalogsService: CatalogsService) {}

  @Get("academic-levels")
  academicLevels() {
    return this.catalogsService.academicLevels();
  }

  @Get("content-types")
  contentTypes() {
    return this.catalogsService.contentTypes();
  }

  @Get("semesters")
  semesters() {
    return this.catalogsService.semesters();
  }

  @Get("programs")
  programs() {
    return this.catalogsService.programs();
  }

  @Get("statuses")
  statuses() {
    return this.catalogsService.statuses();
  }
}
