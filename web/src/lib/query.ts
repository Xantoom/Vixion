import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 10_000,
			refetchOnWindowFocus: true,
			// A refusal won't change by asking again; a network error may.
			retry: (count, error) =>
				count < 3 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
		},
	},
});
