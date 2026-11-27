import { Avatar as DsAvatar } from 'xantoom-design/react';

/** A channel's picture, or its initial when there is none (the design system's avatar). */
export function Avatar({
	src,
	name,
	size = 40,
	live = false,
	className = '',
}: {
	src: string | null | undefined;
	name: string;
	/** In CSS pixels; follows the text size. */
	size?: number;
	/** A red ring around it. */
	live?: boolean;
	className?: string;
}) {
	return (
		<DsAvatar
			src={src}
			name={name}
			size={`${size / 16}rem`}
			className={`${live ? 'ring-live ring-offset-bg ring-2 ring-offset-2' : ''} ${className}`}
		/>
	);
}
