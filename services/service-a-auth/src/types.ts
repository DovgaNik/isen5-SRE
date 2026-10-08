export interface LoginRequest {
  username?: string;
  password?: string;
}

export interface TokenResponse {
  token: string;
  user_id: string;
  expires_in: number;
}

export interface AuthVerifyResponse {
  valid: boolean;
  user_id: string;
  roles?: string[];
}

export interface ErrorResponse {
  error: string;
  message: string;
  status_code: number;
}
