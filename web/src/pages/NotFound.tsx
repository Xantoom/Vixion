import { Link } from '@tanstack/react-router';
import { Compass, Lock } from 'lucide-react';
import { useT } from '@/i18n';

export function NotFound({ forbidden = false }: { forbidden?: boolean }) {
	const t = useT();
	const Icon = forbidden ? Lock : Compass;
	return (
		<div className="panel-in mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-5 px-6 py-16 text-center">
			<span className="bg-surface text-muted grid size-16 place-items-center rounded-full">
				<Icon size={28} />
			</span>
			<div className="flex flex-col gap-2">
				<h1 className="text-title font-semibold tracking-tight">
					{forbidden ? t.errors.forbidden : t.errors.notFound}
				</h1>
				<p className="text-body text-muted">{forbidden ? t.errors.forbiddenLead : t.errors.notFoundLead}</p>
			</div>
			<Link
				to="/"
				className="text-ui bg-accent-fill text-accent-ink inline-flex h-10 items-center rounded-sm px-4.5 font-semibold transition-[filter] hover:brightness-[1.07]"
			>
				{t.errors.home}
			</Link>
		</div>
	);
}
