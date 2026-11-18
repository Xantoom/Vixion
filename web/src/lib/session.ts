import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { ApiError, type Me, type Permission, api } from './api';

/** Who is signed in, or null when nobody is: asked at once, alongside whether setup is needed. */
export const meQuery = {
	queryKey: ['me'],
	queryFn: async (): Promise<Me | null> => {
		try {
			return await api.get<Me>('/me');
		} catch (error) {
			if (error instanceof ApiError && error.status === 401) return null;
			throw error;
		}
	},
	staleTime: 60_000,
};

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
	return useRouterState({ select: (state) => routeParams(state.location.pathname), structuralSharing: true });
}

export function routeParams(pathname: string): { login: string; id: string } {
	const [, login = '', id = ''] = pathname.split('/');
	return { login: decode(login).toLowerCase(), id };
}

/** A typed or pasted address may hold a stray `%`: read as it is rather than stop the app. */
function decode(part: string): string {
	try {
		return decodeURIComponent(part);
	} catch {
		return part;
	}
}
