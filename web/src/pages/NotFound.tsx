import { Link } from '@tanstack/react-router';
import { useT } from '@/i18n';

export function NotFound({ forbidden = false }: { forbidden?: boolean }) {
	const t = useT();
	return (
		<div className="panel-in mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
			<p className="text-lead text-ink-2">{forbidden ? t.errors.forbidden : t.errors.notFound}</p>
			<Link to="/" className="text-ui text-accent-text font-medium hover:underline">
				{t.errors.home}
			</Link>
		</div>
	);
}
