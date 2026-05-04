import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { AuthUser } from "@/auth/types/auth-user.type";

type RequestHeaders = Record<string, string | string[] | undefined>;

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ headers: RequestHeaders; user?: AuthUser }>();
    const token = this.extractToken(this.headerValue(request.headers.authorization)) ?? this.extractCookie(request.headers.cookie);

    if (!token) {
      throw new UnauthorizedException("Missing session token");
    }

    try {
      request.user = await this.jwtService.verifyAsync<AuthUser>(token);
      return true;
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }
  }

  private extractToken(authorization?: string) {
    const [type, token] = authorization?.split(" ") ?? [];
    return type === "Bearer" ? token : undefined;
  }

  private extractCookie(cookieHeader?: string | string[]) {
    const header = this.headerValue(cookieHeader);
    if (!header) return undefined;

    const cookieName = this.config.getOrThrow<string>("session.cookieName");
    const token = header
      .split(";")
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);

    return token ? decodeURIComponent(token) : undefined;
  }

  private headerValue(value?: string | string[]) {
    return Array.isArray(value) ? value[0] : value;
  }
}
