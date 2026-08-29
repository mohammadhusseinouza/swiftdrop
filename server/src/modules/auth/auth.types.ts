export interface SafeUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  isActive: boolean;
  role: {
    id: string;
    code: string;
    name: string;
  };
}

export interface UserAccess {
  user: SafeUser;
  permissions: string[];
}

export interface LoginResult {
  user: SafeUser;
  permissions: string[];
  accessToken: string;
}
