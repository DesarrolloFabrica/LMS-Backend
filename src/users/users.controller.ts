import { Controller, Get, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { Roles } from "@/common/decorators/roles.decorator";
import { UserRole } from "@/common/enums/user-role.enum";
import { JwtAuthGuard } from "@/common/guards/jwt-auth.guard";
import { RolesGuard } from "@/common/guards/roles.guard";
import { UsersService } from "@/users/users.service";

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Roles(UserRole.ADMIN)
  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  @Roles(UserRole.ADMIN)
  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.usersService.findPublicById(id);
  }
}
