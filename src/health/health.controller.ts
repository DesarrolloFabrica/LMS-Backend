import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  @Get()
  health() {
    return {
      status: "ok",
      service: "carga-lms-backend",
      timestamp: new Date().toISOString(),
    };
  }
}
