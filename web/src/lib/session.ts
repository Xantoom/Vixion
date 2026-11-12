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

/** `login` and `id` from `/$login/$id`, read from the address. */
export function useRouteParams(): { login: string; id: string } {
	return useRouterState({
		select: (state) => {
			const [, login = '', id = ''] = state.location.pathname.split('/');
			return { login: decodeURIComponent(login).toLowerCase(), id };
		},
		structuralSharing: true,
	});
}
