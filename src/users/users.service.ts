import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { UserRole } from "@/common/enums/user-role.enum";
import { User } from "@/users/models/user.model";

export type GoogleUserProfile = {
  googleSub: string;
  email: string;
  fullName: string;
  avatarUrl?: string | null;
};

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User) private readonly userModel: typeof User,
  ) {}

  async findAll() {
    return this.userModel.findAll({
      attributes: ["id", "email", "fullName", "role", "area", "avatarUrl", "isActive", "createdAt", "updatedAt"],
      order: [["createdAt", "DESC"]],
    });
  }

  async findById(id: number) {
    const user = await this.userModel.findByPk(id);
    if (!user) {
      throw new NotFoundException("User not found");
    }
    return user;
  }

  async findPublicById(id: number) {
    const user = await this.findById(id);
    return this.toPublicUser(user);
  }

  async upsertFromGoogle(profile: GoogleUserProfile) {
    const normalizedEmail = profile.email.trim().toLowerCase();
    const existing = await this.userModel.findOne({ where: { googleSub: profile.googleSub } });

    if (existing) {
      await existing.update({
        email: normalizedEmail,
        fullName: profile.fullName,
        avatarUrl: profile.avatarUrl ?? null,
      });
      return existing;
    }

    const byEmail = await this.userModel.findOne({ where: { email: normalizedEmail } });
    if (byEmail) {
      await byEmail.update({
        googleSub: profile.googleSub,
        fullName: profile.fullName,
        avatarUrl: profile.avatarUrl ?? null,
      });
      return byEmail;
    }

    return this.userModel.create(
      {
        googleSub: profile.googleSub,
        email: normalizedEmail,
        fullName: profile.fullName,
        avatarUrl: profile.avatarUrl ?? null,
        role: UserRole.FABRICA,
        isActive: true,
      } as User,
      {
        fields: ["googleSub", "email", "fullName", "avatarUrl", "role", "isActive"],
      },
    );
  }

  toPublicUser(user: User) {
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      area: user.area,
      avatarUrl: user.avatarUrl,
      isActive: user.isActive,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

}
