import { UserRole } from "@/common/enums/user-role.enum";

export type AuthUser = {
  sub: number;
  googleSub: string;
  email: string;
  fullName: string;
  role: UserRole;
};
