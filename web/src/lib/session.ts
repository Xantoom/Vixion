import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { type Me, type Permission, api } from './api';

export const meQuery = { queryKey: ['me'], queryFn: async () => api.get<Me>('/me'), staleTime: 60_000 };

/** The signed-in person. Only used under the app shell, where they are known. */
export function useMe(): Me {
	const { data } = useQuery(meQuery);
	if (!data) throw new Error('useMe outside a session');
	return data;
}

export function useCan(permission: Permission): boolean {
	const me = useMe();
	return me.admin || me.permissions.includes(permission);
}

/** The id in `/streamers/$id` or `/streams/$id`, read from the address. */
export function useRouteId(): string {
	return useRouterState({ select: (state) => state.location.pathname.split('/')[2] ?? '' });
}
