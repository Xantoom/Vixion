import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useEffect } from 'react';
import { browserLocale, useT } from './i18n';
import { api, setUnauthorizedHandler } from './lib/api';
import { setProgressOwner } from './lib/progress';
import { meQuery } from './lib/session';
import { LoginPage, SetupPage } from './pages/Auth';
import { preloadPages, router } from './router';
import { usePrefs } from './stores/prefs';
import { Button } from './ui/Button';
import { PageLoading } from './ui/Spinner';
import { Toasts } from './ui/Toasts';
import { Tooltips } from './ui/Tooltips';

/**
 * Who is here decides what shows: the first-run page, the sign-in page, or the app. The sign-in
 * pages have no address of their own, so a link opened while signed out lands where it pointed.
 */
export function App() {
	const client = useQueryClient();
	const t = useT();
	const setup = useQuery({
		queryKey: ['setup'],
		queryFn: async () => api.get<{ needed: boolean }>('/setup'),
		staleTime: Number.POSITIVE_INFINITY,
	});
	// Asked together: who is signed in doesn't wait on whether the server is set up.
	const me = useQuery({ ...meQuery, retry: false });
	// Before any page reads them: watch positions belong to the signed-in account.
	if (me.data) setProgressOwner(me.data.id);

	useEffect(() => {
		setUnauthorizedHandler(() => {
			client.setQueryData(meQuery.queryKey, null);
			void client.invalidateQueries({ queryKey: meQuery.queryKey });
		});
	}, [client]);

	// The account's language applies unless this device chose one.
	useEffect(() => {
		const locale = me.data?.locale;
		if (locale === 'en' || locale === 'fr') {
			if (usePrefs.getState().locale === null) usePrefs.getState().set({ locale });
		}
		document.documentElement.lang = usePrefs.getState().locale ?? browserLocale();
	}, [me.data?.locale]);

	// Signed in: the other pages are fetched in the background, so the first visit to each is instant.
	const signedIn = Boolean(me.data);
	const admin = Boolean(
		me.data && (me.data.admin || me.data.permissions.some((p) => /^(stats|logs|users|settings)\./.test(p))),
	);
	useEffect(() => {
		if (signedIn) preloadPages(admin);
	}, [signedIn, admin]);

	let page;
	if (setup.isPending || (setup.data?.needed === false && me.isPending)) {
		page = <PageLoading />;
	} else if (setup.isError) {
		page = (
			<div className="grid min-h-dvh place-items-center p-6 text-center">
				<div className="flex flex-col items-center gap-4">
					<p className="text-ui text-ink-2">{t.common.offline}</p>
					<Button onClick={() => void setup.refetch()}>{t.common.retry}</Button>
				</div>
			</div>
		);
	} else if (setup.data?.needed) {
		page = <SetupPage />;
	} else if (!me.data) {
		page = <LoginPage />;
	} else {
		page = <RouterProvider router={router} />;
	}

	return (
		<>
			{page}
			<Toasts />
			<Tooltips />
		</>
	);
}
