import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { UserRole } from '@merge/shared';
import { api, getToken, setToken } from '../api/client';
import type { Me, Organisation, User } from '../api/types';
import type { LoginResponse, SecurityState } from '../api/types.compliance';

/** What the platform insists on before this user can do anything else. */
export type SecurityGate = 'TWO_FACTOR' | 'PASSWORD' | null;

export interface LoginResult {
  /** Set when the password was right but an authenticator code is still needed. */
  challengeToken?: string;
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  /** Second step of login for accounts with an authenticator app. */
  verifyTwoFactor: (challengeToken: string, code: string) => Promise<void>;
  register: (payload: unknown) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
  isManager: boolean;
  isAdmin: boolean;
  isPlatformAdmin: boolean;
  isWorker: boolean;
  user: User | null;
  organisation: Organisation | null;
  gate: SecurityGate;
  security: SecurityState | null;
}

const AuthContext = createContext<AuthState | null>(null);

type MeWithSecurity = Me & { security?: SecurityState };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeWithSecurity | null>(null);
  const [loading, setLoading] = useState<boolean>(!!getToken());
  const qc = useQueryClient();

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setMe(null);
      setLoading(false);
      return;
    }
    try {
      const data = await api.get<MeWithSecurity>('/auth/me');
      setMe(data);
    } catch {
      setToken(null);
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startSession = useCallback(
    async (token: string) => {
      setToken(token);
      qc.clear();
      setLoading(true);
      await refresh();
    },
    [qc, refresh],
  );

  const login = useCallback(
    async (email: string, password: string): Promise<LoginResult> => {
      const res = await api.post<LoginResponse>('/auth/login', { email, password });
      if (res.twoFactorRequired && res.challengeToken) return { challengeToken: res.challengeToken };
      if (!res.token) throw new Error('Sign-in did not return a session');
      await startSession(res.token);
      return {};
    },
    [startSession],
  );

  const verifyTwoFactor = useCallback(
    async (challengeToken: string, code: string) => {
      const res = await api.post<{ token: string }>('/auth/2fa/verify', { challengeToken, code });
      await startSession(res.token);
    },
    [startSession],
  );

  const register = useCallback(
    async (payload: unknown) => {
      const res = await api.post<{ token: string }>('/auth/register', payload);
      await startSession(res.token);
    },
    [startSession],
  );

  const logout = useCallback(() => {
    setToken(null);
    qc.clear();
    setMe(null);
  }, [qc]);

  const value = useMemo<AuthState>(() => {
    const role = me?.user.role;
    const security = me?.security ?? null;
    const gate: SecurityGate = security?.passwordChangeRequired ? 'PASSWORD' : security?.twoFactorSetupRequired ? 'TWO_FACTOR' : null;
    return {
      me,
      loading,
      login,
      verifyTwoFactor,
      register,
      logout,
      refresh,
      user: me?.user ?? null,
      organisation: me?.organisation ?? null,
      isPlatformAdmin: role === UserRole.PLATFORM_ADMIN,
      isAdmin: role === UserRole.PLATFORM_ADMIN || role === UserRole.ORG_ADMIN,
      isManager: role === UserRole.PLATFORM_ADMIN || role === UserRole.ORG_ADMIN || role === UserRole.ORG_MANAGER,
      isWorker: role === UserRole.WORKER,
      gate,
      security,
    };
  }, [me, loading, login, verifyTwoFactor, register, logout, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
