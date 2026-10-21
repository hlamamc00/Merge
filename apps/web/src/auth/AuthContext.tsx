import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { UserRole } from '@merge/shared';
import { api, getToken, setToken } from '../api/client';
import type { Me, Organisation, User } from '../api/types';

interface AuthState {
  me: Me | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (payload: unknown) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
  isManager: boolean;
  isAdmin: boolean;
  isPlatformAdmin: boolean;
  isWorker: boolean;
  user: User | null;
  organisation: Organisation | null;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState<boolean>(!!getToken());
  const qc = useQueryClient();

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setMe(null);
      setLoading(false);
      return;
    }
    try {
      const data = await api.get<Me>('/auth/me');
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

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api.post<{ token: string }>('/auth/login', { email, password });
      setToken(res.token);
      qc.clear();
      setLoading(true);
      await refresh();
    },
    [qc, refresh],
  );

  const register = useCallback(
    async (payload: unknown) => {
      const res = await api.post<{ token: string }>('/auth/register', payload);
      setToken(res.token);
      qc.clear();
      setLoading(true);
      await refresh();
    },
    [qc, refresh],
  );

  const logout = useCallback(() => {
    setToken(null);
    qc.clear();
    setMe(null);
  }, [qc]);

  const value = useMemo<AuthState>(() => {
    const role = me?.user.role;
    return {
      me,
      loading,
      login,
      register,
      logout,
      refresh,
      user: me?.user ?? null,
      organisation: me?.organisation ?? null,
      isPlatformAdmin: role === UserRole.PLATFORM_ADMIN,
      isAdmin: role === UserRole.PLATFORM_ADMIN || role === UserRole.ORG_ADMIN,
      isManager: role === UserRole.PLATFORM_ADMIN || role === UserRole.ORG_ADMIN || role === UserRole.ORG_MANAGER,
      isWorker: role === UserRole.WORKER,
    };
  }, [me, loading, login, register, logout, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
