import {
	type CSSProperties,
	type ReactNode,
	useId,
	useRef,
	useState,
} from "react";
import {
	MAX_SOURCE_DIRECTORY_WIDTH,
	MIN_SOURCE_DIRECTORY_WIDTH,
	sourceDirectoryWidth,
} from "./directory-layout";
import { readPreference, savePreference } from "./hooks";

export function SourceSpace({
	directory,
	children,
}: {
	directory: ReactNode;
	children: ReactNode;
}) {
	const panelId = useId();
	const [width, setWidth] = useState(() =>
		sourceDirectoryWidth(readPreference("source-directory-width")),
	);
	const drag = useRef<{
		pointerId: number;
		x: number;
		width: number;
		lastWidth: number;
	} | null>(null);

	function finishResize(pointerId: number) {
		if (drag.current?.pointerId !== pointerId) return;
		savePreference("source-directory-width", String(drag.current.lastWidth));
		drag.current = null;
	}

	return (
		<div
			className="s2-space"
			style={{ "--source-directory-width": `${width}px` } as CSSProperties}
		>
			<aside id={panelId} className="s2-source-panel">
				{directory}
				<hr
					className="s2-source-resizer"
					aria-label="调整来源栏宽度"
					aria-controls={panelId}
					aria-orientation="vertical"
					aria-valuemin={MIN_SOURCE_DIRECTORY_WIDTH}
					aria-valuemax={MAX_SOURCE_DIRECTORY_WIDTH}
					aria-valuenow={width}
					tabIndex={0}
					onPointerDown={(event) => {
						if (event.button !== 0) return;
						event.preventDefault();
						event.currentTarget.focus();
						drag.current = {
							pointerId: event.pointerId,
							x: event.clientX,
							width,
							lastWidth: width,
						};
						event.currentTarget.setPointerCapture(event.pointerId);
					}}
					onPointerMove={(event) => {
						const start = drag.current;
						if (start?.pointerId !== event.pointerId) return;
						start.lastWidth = sourceDirectoryWidth(
							start.width + event.clientX - start.x,
						);
						setWidth(start.lastWidth);
					}}
					onPointerUp={(event) => finishResize(event.pointerId)}
					onLostPointerCapture={(event) => finishResize(event.pointerId)}
					onPointerCancel={() => {
						if (drag.current) setWidth(drag.current.width);
						drag.current = null;
					}}
					onKeyDown={(event) => {
						const step = event.shiftKey ? 20 : 10;
						const next =
							event.key === "ArrowLeft"
								? width - step
								: event.key === "ArrowRight"
									? width + step
									: event.key === "Home"
										? MIN_SOURCE_DIRECTORY_WIDTH
										: event.key === "End"
											? MAX_SOURCE_DIRECTORY_WIDTH
											: null;
						if (next === null) return;
						event.preventDefault();
						const resized = sourceDirectoryWidth(next);
						setWidth(resized);
						savePreference("source-directory-width", String(resized));
					}}
				/>
			</aside>
			{children}
		</div>
	);
}
