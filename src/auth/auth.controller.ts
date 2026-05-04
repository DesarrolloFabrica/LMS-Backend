import { Body, Controller, Get, Post, Res, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthService } from "@/auth/auth.service";
import { AuthUser } from "@/auth/types/auth-user.type";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { JwtAuthGuard } from "@/common/guards/jwt-auth.guard";
import { GoogleLoginDto } from "@/auth/dto/google-login.dto";
import { UsersService } from "@/users/users.service";

type SameSite = "lax" | "strict" | "none";

type CookieOptions = {
  httpOnly?: boolean;
  maxAge?: number;
  path?: string;
  sameSite?: SameSite;
  secure?: boolean;
};

type CookieResponse = {
  cookie: (name: string, value: string, options: CookieOptions) => void;
  clearCookie: (name: string, options: CookieOptions) => void;
};

@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
    private readonly usersService: UsersService,
  ) {}

  @Post("google")
  async loginGoogle(@Body() dto: GoogleLoginDto, @Res({ passthrough: true }) response: CookieResponse) {
    const session = await this.authService.loginWithGoogle(dto.credential);
    response.cookie(this.cookieName(), session.accessToken, this.cookieOptions(session.expiresIn));

    return {
      tokenType: session.tokenType,
      expiresIn: session.expiresIn,
      user: session.user,
    };
  }

  @Post("logout")
  logout(@Res({ passthrough: true }) response: CookieResponse) {
    response.clearCookie(this.cookieName(), this.clearCookieOptions());
    return { ok: true };
  }

  @UseGuards(JwtAuthGuard)
  @Post("refresh")
  async refresh(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) response: CookieResponse) {
    const session = await this.authService.refreshSession(user);
    response.cookie(this.cookieName(), session.accessToken, this.cookieOptions(session.expiresIn));

    return {
      tokenType: session.tokenType,
      expiresIn: session.expiresIn,
      user: session.user,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get("me")
  me(@CurrentUser() user: AuthUser) {
    return this.usersService.findPublicById(user.sub);
  }

  private cookieName() {
    return this.config.getOrThrow<string>("session.cookieName");
  }

  private cookieOptions(expiresIn: string): CookieOptions {
    return {
      httpOnly: true,
      maxAge: this.durationToMs(expiresIn),
      path: "/",
      sameSite: this.sameSite(),
      secure: this.config.getOrThrow<boolean>("session.cookieSecure"),
    };
  }

  private clearCookieOptions(): CookieOptions {
    return {
      path: "/",
      sameSite: this.sameSite(),
      secure: this.config.getOrThrow<boolean>("session.cookieSecure"),
    };
  }

  private sameSite(): SameSite {
    const value = this.config.get<string>("session.cookieSameSite")?.toLowerCase();
    return value === "none" || value === "strict" || value === "lax" ? value : "lax";
  }

  private durationToMs(value: string) {
    const match = value.trim().match(/^(\d+)(ms|s|m|h|d)?$/i);
    if (!match) return 4 * 60 * 60 * 1000;

    const amount = Number(match[1]);
    const unit = match[2]?.toLowerCase() ?? "ms";
    const multipliers: Record<string, number> = {
      ms: 1,
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };

    return amount * multipliers[unit];
  }
}
