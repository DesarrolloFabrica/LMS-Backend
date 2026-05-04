import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { OAuth2Client } from "google-auth-library";
import { AuthUser } from "@/auth/types/auth-user.type";
import { User } from "@/users/models/user.model";
import { UsersService } from "@/users/users.service";

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly oauthClient: OAuth2Client;

  constructor(
    private readonly config: ConfigService,
    private readonly jwtService: JwtService,
    private readonly usersService: UsersService,
  ) {
    this.oauthClient = new OAuth2Client(this.config.getOrThrow<string>("google.clientId"));
  }

  async loginWithGoogle(credential: string) {
    const clientId = this.config.getOrThrow<string>("google.clientId");

    const ticket = await this.oauthClient.verifyIdToken({
      idToken: credential,
      audience: clientId,
    });
    const payload = ticket.getPayload();

    if (!payload?.sub || !payload.email || payload.email_verified !== true) {
      throw new UnauthorizedException("Google token is not valid for this application");
    }

    this.assertAllowedDomain(payload.email, payload.hd);

    const user = await this.usersService.upsertFromGoogle({
      googleSub: payload.sub,
      email: payload.email,
      fullName: payload.name ?? payload.email,
      avatarUrl: payload.picture,
    });

    if (!user.isActive) {
      this.logger.warn(`Inactive user blocked during Google login: userId=${user.id} email=${user.email}`);
      throw new UnauthorizedException("User is inactive");
    }

    this.logger.log(`Google login completed: userId=${user.id} role=${user.role} domain=${user.email.split("@")[1]}`);
    return this.buildSession(user);
  }

  async buildSession(user: User) {
    const payload: AuthUser = {
      sub: user.id,
      googleSub: user.googleSub,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
    };

    return {
      accessToken: await this.jwtService.signAsync(payload),
      tokenType: "Cookie",
      expiresIn: this.config.getOrThrow<string>("jwt.expiresIn"),
      user: this.usersService.toPublicUser(user),
    };
  }

  async refreshSession(authUser: AuthUser) {
    const user = await this.usersService.findById(authUser.sub);
    if (!user.isActive) {
      this.logger.warn(`Inactive user blocked during session refresh: userId=${user.id}`);
      throw new UnauthorizedException("User is inactive");
    }

    this.logger.log(`Session refreshed: userId=${user.id} role=${user.role}`);
    return this.buildSession(user);
  }

  private assertAllowedDomain(email: string, hostedDomain?: string) {
    const allowedDomain = this.config.get<string>("google.allowedDomain");
    if (!allowedDomain) {
      return;
    }

    const normalized = allowedDomain.toLowerCase();
    const emailDomain = email.split("@")[1]?.toLowerCase();
    const tokenDomain = hostedDomain?.toLowerCase();

    if (emailDomain !== normalized && tokenDomain !== normalized) {
      this.logger.warn(`Google domain rejected: emailDomain=${emailDomain ?? "unknown"} hostedDomain=${tokenDomain ?? "none"}`);
      throw new UnauthorizedException("Google account domain is not allowed");
    }
  }
}
