import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { AssignmentListItem, AvailableShift, CapacityFlag, NetworkCapacity, OrgStats, Site, TimesheetListItem, WorkerListItem } from './types';

export function useSites(orgId: string | undefined) {
  return useQuery({ queryKey: ['sites', orgId], queryFn: () => api.get<Site[]>(`/organisations/${orgId}/sites`), enabled: !!orgId });
}

export function useWorkers(params: Record<string, string | undefined> = {}) {
  return useQuery({ queryKey: ['workers', params], queryFn: () => api.get<WorkerListItem[]>('/workers', params) });
}

export function useAvailableShifts(params: Record<string, string | undefined> = {}) {
  return useQuery({ queryKey: ['shifts', 'available', params], queryFn: () => api.get<AvailableShift[]>('/shifts', { scope: 'available', ...params }), refetchInterval: 60_000 });
}

export function useFlags(params: Record<string, string | undefined> = {}) {
  return useQuery({ queryKey: ['flags', params], queryFn: () => api.get<CapacityFlag[]>('/capacity/flags', params) });
}

export function useNetworkCapacity() {
  return useQuery({ queryKey: ['capacity-network'], queryFn: () => api.get<NetworkCapacity>('/capacity/network') });
}

export function useAssignments(scope: 'incoming' | 'outgoing', status?: string) {
  return useQuery({ queryKey: ['assignments', scope, status], queryFn: () => api.get<AssignmentListItem[]>('/assignments', { scope, status }) });
}

export function useTimesheets(scope: 'payable' | 'receivable' | 'all', status?: string) {
  return useQuery({ queryKey: ['timesheets', scope, status], queryFn: () => api.get<TimesheetListItem[]>('/timesheets', { scope, status }) });
}

export function useOrgStats(orgId: string | undefined, enabled = true) {
  return useQuery({ queryKey: ['org-stats', orgId], queryFn: () => api.get<OrgStats>(`/organisations/${orgId}/stats`), enabled: !!orgId && enabled });
}

/** Invalidate everything shift-related after a mutation. */
export function useInvalidateAll() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
}

export function useAction<TArgs = void, TResult = unknown>(fn: (args: TArgs) => Promise<TResult>, onDone?: (r: TResult) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      void qc.invalidateQueries();
      onDone?.(r);
    },
  });
}
