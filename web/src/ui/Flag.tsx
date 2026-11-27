import { Flag as DsFlag } from 'xantoom-design/react';
import type { Locale } from '@/i18n';

/**
 * A language's flag, drawn by the design system (Windows shows flag emojis as two letters). Round, so the two
 * flags weigh the same beside each other.
 */
export function Flag({ locale, size = 20 }: { locale: Locale; size?: number }) {
	return (
		<span className="flex flex-none" style={{ inlineSize: size, blockSize: size }}>
			<DsFlag code={locale === 'fr' ? 'fr' : 'gb'} className="size-full rounded-full" />
		</span>
	);
}
