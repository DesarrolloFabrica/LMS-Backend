import { Module } from "@nestjs/common";
import { MegaService } from "./mega.service";

@Module({
  providers: [MegaService],
  exports: [MegaService],
})
export class MegaModule {}
