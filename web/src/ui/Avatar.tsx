import { useState } from 'react';

/** A channel's picture, or its initial on a tint picked from its name when there is none. */
export function Avatar({
	src,
	name,
	size = 40,
	live = false,
	className = '',
}: {
	src: string | null | undefined;
	name: string;
	size?: number;
	/** A red ring around it. */
	live?: boolean;
	className?: string;
}) {
	const [failed, setFailed] = useState(false);
	let hue = 0;
	for (let i = 0; i < name.length; i++) hue = (hue + name.charCodeAt(i)) % 360;
	const ring = live ? 'ring-2 ring-live ring-offset-2 ring-offset-bg' : '';
	return src && !failed ? (
		<img
			src={src}
			alt=""
			width={size}
			height={size}
			loading="lazy"
			decoding="async"
			referrerPolicy="no-referrer"
			onError={() => {
				setFailed(true);
			}}
			className={`bg-surface flex-none rounded-full object-cover ${ring} ${className}`}
			style={{ width: size, height: size }}
		/>
	) : (
		<span
			aria-hidden="true"
			className={`grid flex-none place-items-center rounded-full font-semibold text-white ${ring} ${className}`}
			style={{ width: size, height: size, fontSize: size * 0.42, background: `oklch(0.55 0.12 ${hue})` }}
		>
			{name.slice(0, 1).toUpperCase()}
		</span>
	);
}
