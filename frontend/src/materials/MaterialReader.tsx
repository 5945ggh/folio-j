import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { InlineError, Loading, PageError, Shell } from "../Shared";
import {
	type Chapter,
	getChapter,
	getMaterial,
	type Material,
	materialKeys,
	type Position,
	type Settings,
	savePosition,
} from "./api";
import {
	htmlEscape,
	nearestText,
	type Projection,
	projectPart,
	textRect,
} from "./dom";
import { cacheSavedPosition, registerPositionWriter } from "./persistence";
import {
	anchorBeforeLayout,
	currentSurface,
	imageCoordinate,
	imageFraction,
	PositionQueue,
	scrollProgress,
} from "./position";
import { type LayoutPass, ViewportRecovery, viewportSize } from "./viewport";

const defaults: Settings = {
	font_size: 20,
	line_height: 1.8,
	writing_mode: "horizontal-tb",
};
type Frame = {
	element: HTMLIFrameElement;
	doc: Document;
	projection: Projection;
	resize: () => void;
};
function partDocument(
	part: Chapter["parts"][number],
	resource: Chapter["resources"][number],
	settings: Settings,
) {
	const attrs = (values: Record<string, string>) =>
		Object.entries(values)
			.filter(([key]) => ["class", "lang", "dir"].includes(key))
			.map(([k, v]) => `${k}="${htmlEscape(v)}"`)
			.join(" ");
	// Compiled author CSS is isolated in this document; CSP prevents external resource loads.
	return `<!doctype html><html ${attrs(resource.html_attributes)}><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; connect-src 'none'"><style>${resource.css.replace(/<\/style/gi, "&lt;/style")}</style><style>html,body{margin:0!important;padding:0!important;background:transparent!important;}body{font-size:${settings.font_size}px!important;line-height:${settings.line_height}!important;writing-mode:${settings.writing_mode}!important;color:#292b28!important;}img{max-width:100%;max-height:600px;object-fit:contain;}ruby rt{font-size:.55em;}a{pointer-events:none;}html,body{overflow:hidden!important;}</style></head><body ${attrs(resource.body_attributes)}>${part.html}</body></html>`;
}
function Reader({ book, notice }: { book: Material; notice: boolean }) {
	const client = useQueryClient();
	const warnings = Array.from(new Set(book.warnings));
	const [chapterId, setChapterId] = useState(
		book.reading_position?.chapter_id ?? book.chapters[0]?.id ?? "",
	);
	const [settings, setSettings] = useState<Settings>(
		book.reading_position?.settings ?? defaults,
	);
	const [expanded, setExpanded] = useState(false);
	const [progress, setProgress] = useState(0);
	const [status, setStatus] = useState("已保存");
	const [error, setError] = useState<Error | null>(null);
	const chapter = useQuery({
		queryKey: materialKeys.chapter(book.id, chapterId),
		queryFn: () => getChapter(book.id, chapterId),
		enabled: !!chapterId,
	});
	const container = useRef<HTMLElement>(null);
	const frames = useRef(new Map<number, Frame>());
	const ready = useRef(new Set<number>());
	const elements = useRef(new Map<number, HTMLIFrameElement>());
	const layoutTicket = useRef(0);
	const recovery = useRef(new ViewportRecovery());
	const generation = useRef(0);
	const pending = useRef<Position | null>(book.reading_position);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const alive = useRef(true);
	const queue = useRef<PositionQueue<Position> | null>(null);
	if (!queue.current)
		queue.current = new PositionQueue(
			book.reading_position?.revision ?? 0,
			async (value, revision) => {
				const saved = await savePosition(book.id, value, revision);
				cacheSavedPosition<Material>(client, book.id, saved);
				return saved.revision;
			},
			(state, failure) => {
				if (!alive.current) return;
				setStatus(
					state === "saving"
						? "保存中…"
						: state === "saved"
							? "已保存"
							: "保存失败",
				);
				if (failure)
					setError(
						failure instanceof Error ? failure : new Error(String(failure)),
					);
			},
		);
	const capture = useCallback((): Position | null => {
		const root = container.current;
		if (
			!root ||
			!chapter.data ||
			!recovery.current.canSample(viewportSize(root))
		)
			return null;
		const vertical = settings.writing_mode === "vertical-rl";
		const viewport = root.getBoundingClientRect();
		const edge = vertical ? viewport.right : viewport.top;
		let best: { index: number; frame: Frame; distance: number } | undefined;
		for (const [index, frame] of frames.current) {
			const rect = frame.element.getBoundingClientRect();
			const intersects = vertical
				? rect.left < viewport.right && rect.right > viewport.left
				: rect.top < viewport.bottom && rect.bottom > viewport.top;
			if (!intersects) continue;
			const distance = Math.abs((vertical ? rect.right : rect.top) - edge);
			if (!best || distance < best.distance) best = { index, frame, distance };
		}
		if (!best) return null;
		const part = chapter.data.parts[best.index];
		if (!part) return null;
		const rect = best.frame.element.getBoundingClientRect();
		const local = vertical ? edge - rect.left : edge - rect.top;
		const base = {
			version_id: book.version_id,
			chapter_id: chapterId,
			part_index: best.index,
			resource_id: part.resource_id,
			settings,
		};
		for (const image of best.frame.doc.querySelectorAll<HTMLElement>(
			"[data-epub-image]",
		)) {
			const r = image.getBoundingClientRect();
			const start = vertical ? r.left : r.top;
			const size = vertical ? r.width : r.height;
			if (size > 0 && local >= start && local <= start + size)
				return {
					...base,
					kind: "image",
					image_id: Number(image.dataset.epubImage),
					image_progress: imageFraction(local, start, size, vertical),
				};
		}
		const point = nearestText(
			best.frame.doc,
			best.frame.projection,
			local,
			vertical,
		);
		if (point !== undefined)
			return { ...base, kind: "text", offset: part.start + point };
		const image =
			best.frame.doc.querySelector<HTMLElement>("[data-epub-image]");
		if (image)
			return {
				...base,
				kind: "image",
				image_id: Number(image.dataset.epubImage),
				image_progress: 0,
			};
		return null;
	}, [book.version_id, chapterId, chapter.data, settings]);
	const observe = useCallback(() => {
		const root = container.current;
		if (!root) return;
		const vertical = settings.writing_mode === "vertical-rl";
		setProgress(
			scrollProgress(
				vertical ? Math.abs(root.scrollLeft) : root.scrollTop,
				vertical
					? root.scrollWidth - root.clientWidth
					: root.scrollHeight - root.clientHeight,
			),
		);
		const anchor = recovery.current.observe(viewportSize(root), capture);
		if (!recovery.current.canSample(viewportSize(root))) {
			if (timer.current) clearTimeout(timer.current);
			return;
		}
		if (!anchor) return;
		pending.current = anchor;
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => queue.current?.enqueue(anchor), 550);
	}, [capture, settings.writing_mode]);
	const restore = useCallback(
		(pass: LayoutPass) => {
			const root = container.current;
			const data = chapter.data;
			if (
				!recovery.current.restoring ||
				!root ||
				!data ||
				ready.current.size !== data.parts.length ||
				!recovery.current.canFinish(pass, viewportSize(root))
			)
				return;
			const anchor = pending.current;
			const vertical = settings.writing_mode === "vertical-rl";
			if (anchor && anchor.chapter_id === chapterId) {
				const frame = frames.current.get(anchor.part_index);
				const part = data.parts[anchor.part_index];
				if (frame && part && part.resource_id === anchor.resource_id) {
					let rect: DOMRect | null = null;
					try {
						if (anchor.kind === "text")
							rect = textRect(
								frame.doc,
								frame.projection,
								Math.max(
									0,
									Math.min(
										part.end - part.start,
										(anchor.offset ?? part.start) - part.start,
									),
								),
							);
						else
							rect =
								frame.doc
									.querySelector<HTMLElement>(
										`[data-epub-image="${anchor.image_id}"]`,
									)
									?.getBoundingClientRect() ?? null;
					} catch {
						setStatus("已恢复到附近位置");
					}
					if (rect) {
						const outer = frame.element.getBoundingClientRect();
						const view = root.getBoundingClientRect();
						if (vertical)
							root.scrollLeft +=
								outer.left +
								(anchor.kind === "image"
									? imageCoordinate(
											anchor.image_progress ?? 0,
											rect.left,
											rect.width,
											true,
										)
									: rect.right) -
								view.right;
						else
							root.scrollTop +=
								outer.top +
								rect.top -
								view.top +
								(anchor.kind === "image"
									? rect.height * (anchor.image_progress ?? 0)
									: 0);
					}
				}
			}
			if (!recovery.current.finish(pass, viewportSize(root))) return;
			observe();
		},
		[chapter.data, chapterId, settings.writing_mode, observe],
	);
	useEffect(() => {
		alive.current = true;
		const unregister = queue.current
			? registerPositionWriter(book.id, queue.current)
			: () => {};
		return () => {
			alive.current = false;
			if (timer.current) clearTimeout(timer.current);
			if (!recovery.current.restoring && pending.current)
				queue.current?.enqueue(pending.current);
			unregister();
		};
	}, [book.id]);
	const load = (index: number, element: HTMLIFrameElement, token: number) => {
		const valid = () =>
			currentSurface(
				token,
				generation.current,
				element.isConnected,
				elements.current.get(index) === element &&
					!!container.current?.contains(element),
			);
		if (!valid()) return;
		const doc = element.contentDocument;
		const data = chapter.data;
		if (!doc || !data) return;
		const part = data.parts[index];
		if (!part) return;
		const resource = data.resources.find((r) => r.id === part.resource_id);
		if (!resource) return;
		try {
			const projection = projectPart(
				doc,
				Array.from(resource.text).slice(part.start, part.end).join(""),
				part.leaf_start,
			);
			const resize = () => {
				if (!valid()) return;
				const vertical = settings.writing_mode === "vertical-rl";
				const root = container.current;
				if (root)
					for (const image of doc.images) {
						image.style.setProperty("width", "auto", "important");
						image.style.setProperty("height", "auto", "important");
						image.style.setProperty(
							"max-height",
							`${Math.max(100, root.clientHeight * 0.9)}px`,
							"important",
						);
						image.style.setProperty(
							"max-width",
							`${Math.max(100, root.clientWidth * 0.9)}px`,
							"important",
						);
					}
				if (vertical) {
					element.style.height = "100%";
					doc.body.style.setProperty("height", "100%", "important");
					doc.body.style.setProperty("width", "max-content", "important");
					element.style.width = "1px";
					element.style.width = `${Math.max(100, doc.body.scrollWidth, doc.documentElement.scrollWidth)}px`;
				} else {
					element.style.width = "100%";
					doc.body.style.setProperty("height", "auto", "important");
					doc.body.style.setProperty("width", "auto", "important");
					element.style.height = "1px";
					element.style.height = `${Math.max(32, doc.body.scrollHeight, doc.documentElement.scrollHeight)}px`;
				}
			};
			frames.current.set(index, { element, doc, projection, resize });
			resize();
			void Promise.all([
				doc.fonts.ready,
				...Array.from(doc.images).map((image) =>
					image.complete
						? Promise.resolve()
						: new Promise<void>((resolve) => {
								image.onload = () => resolve();
								image.onerror = () => resolve();
							}),
				),
			]).then(() => {
				if (!valid()) return;
				resize();
				ready.current.add(index);
				requestAnimationFrame(() =>
					requestAnimationFrame(() => {
						if (valid() && ready.current.size === data.parts.length) {
							for (const frame of frames.current.values()) frame.resize();
							const root = container.current;
							if (!root) return;
							const pass = recovery.current.begin(viewportSize(root));
							requestAnimationFrame(() =>
								requestAnimationFrame(() => {
									if (valid()) restore(pass);
								}),
							);
						}
					}),
				);
			});
		} catch (failure) {
			setError(failure instanceof Error ? failure : new Error(String(failure)));
		}
	};
	useEffect(() => {
		const root = container.current;
		if (!root) return;
		let scheduled: number | undefined;
		let lastWidth = root.clientWidth,
			lastHeight = root.clientHeight;
		const resize = () => {
			const width = root.clientWidth,
				height = root.clientHeight;
			if (width === lastWidth && height === lastHeight) return;
			lastWidth = width;
			lastHeight = height;
			if (!recovery.current.restoring)
				pending.current = pending.current ?? capture();
			const pass = recovery.current.begin({ width, height });
			if (timer.current) clearTimeout(timer.current);
			const ticket = ++layoutTicket.current;
			const token = generation.current;
			if (scheduled !== undefined) cancelAnimationFrame(scheduled);
			scheduled = requestAnimationFrame(() => {
				for (const frame of frames.current.values()) frame.resize();
				void Promise.all(
					Array.from(frames.current.values()).map(
						(frame) => frame.doc.fonts.ready,
					),
				).then(() =>
					requestAnimationFrame(() =>
						requestAnimationFrame(() => {
							if (
								alive.current &&
								ticket === layoutTicket.current &&
								token === generation.current
							)
								restore(pass);
						}),
					),
				);
			});
		};
		const observer = new ResizeObserver(resize);
		observer.observe(root);
		window.addEventListener("resize", resize);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", resize);
			if (scheduled !== undefined) cancelAnimationFrame(scheduled);
			layoutTicket.current++;
		};
	}, [capture, restore]);
	const choose = (id: string) => {
		if (timer.current) clearTimeout(timer.current);
		const last = anchorBeforeLayout(
			recovery.current.restoring,
			pending.current,
			capture,
		);
		if (last) queue.current?.enqueue(last);
		generation.current++;
		recovery.current.invalidate();
		pending.current = null;
		frames.current.clear();
		ready.current.clear();
		setChapterId(id);
		setProgress(0);
	};
	const change = (next: Settings) => {
		if (timer.current) clearTimeout(timer.current);
		const anchor = anchorBeforeLayout(
			recovery.current.restoring,
			pending.current,
			capture,
		);
		pending.current = anchor ? { ...anchor, settings: next } : null;
		generation.current++;
		recovery.current.invalidate();
		frames.current.clear();
		ready.current.clear();
		setSettings(next);
	};
	const renderToken = generation.current;
	return (
		<Shell>
			<div className="material-heading">
				<Link
					className="breadcrumb"
					to={`/sources/${book.source_id}`}
					onClick={() => {
						if (timer.current) clearTimeout(timer.current);
						const anchor = anchorBeforeLayout(
							recovery.current.restoring,
							pending.current,
							capture,
						);
						if (anchor) {
							pending.current = anchor;
							queue.current?.enqueue(anchor);
						}
					}}
				>
					← 返回来源
				</Link>
				<h1 className="material-title">{book.title}</h1>
				{notice && <p role="status">已打开此前导入的材料。</p>}
				{warnings.length > 0 && (
					<details className="material-import-notes">
						<summary>导入提示（{warnings.length}）</summary>
						<ul>
							{warnings.map((warning) => (
								<li key={warning}>{warning}</li>
							))}
						</ul>
					</details>
				)}
				<div className="material-tools">
					<label>
						目录{" "}
						<select
							aria-label="阅读章节"
							value={chapterId}
							onChange={(e) => choose(e.target.value)}
						>
							{book.chapters.map((c) => (
								<option key={c.id} value={c.id}>
									{"　".repeat(Math.max(0, c.level - 1))}
									{c.title}
								</option>
							))}
						</select>
					</label>
					<button
						className="button secondary"
						type="button"
						onClick={() => setExpanded(!expanded)}
						aria-expanded={expanded}
					>
						阅读设置
					</button>
				</div>
				{expanded && (
					<div className="material-settings">
						<label>
							字号{" "}
							<input
								aria-label="字号"
								type="range"
								min="12"
								max="40"
								value={settings.font_size}
								onChange={(e) =>
									change({ ...settings, font_size: Number(e.target.value) })
								}
							/>
							{settings.font_size}
						</label>
						<label>
							行距{" "}
							<input
								aria-label="行距"
								type="range"
								min="1"
								max="3"
								step="0.1"
								value={settings.line_height}
								onChange={(e) =>
									change({ ...settings, line_height: Number(e.target.value) })
								}
							/>
							{settings.line_height}
						</label>
						<label>
							排版{" "}
							<select
								aria-label="排版"
								value={settings.writing_mode}
								onChange={(e) =>
									change({
										...settings,
										writing_mode: e.target.value as Settings["writing_mode"],
									})
								}
							>
								<option value="horizontal-tb">横排</option>
								<option value="vertical-rl">竖排</option>
							</select>
						</label>
					</div>
				)}
			</div>
			<InlineError error={error} />
			<div className="material-status" aria-live="polite">
				<span>{Math.round(progress * 100)}% · 章内进度</span>
				<span>{status}</span>
				{error && (
					<button
						type="button"
						className="button secondary"
						onClick={() => window.location.reload()}
					>
						重新打开
					</button>
				)}
			</div>
			{chapter.isPending ? (
				<p>正在打开章节…</p>
			) : chapter.isError ? (
				<PageError error={chapter.error} retry={() => void chapter.refetch()} />
			) : (
				<section
					key={chapterId}
					ref={container}
					onScroll={observe}
					className={`material-reading ${settings.writing_mode === "vertical-rl" ? "material-vertical" : ""}`}
					aria-label={chapter.data.title}
				>
					{chapter.data.parts.map((part, index) => {
						const resource = chapter.data.resources.find(
							(r) => r.id === part.resource_id,
						);
						return resource ? (
							<iframe
								key={`${chapterId}-${part.spine_index}-${part.resource_id}-${part.start}-${settings.font_size}-${settings.line_height}-${settings.writing_mode}`}
								title={`${chapter.data.title} ${index + 1}`}
								className="material-part"
								sandbox="allow-same-origin"
								srcDoc={partDocument(part, resource, settings)}
								ref={(element) => {
									if (element) elements.current.set(index, element);
									else elements.current.delete(index);
								}}
								onLoad={(e) => load(index, e.currentTarget, renderToken)}
							/>
						) : null;
					})}
				</section>
			)}
		</Shell>
	);
}
function MaterialOpening({ id }: { id: string }) {
	const location = useLocation();
	const navigate = useNavigate();
	const [notice] = useState(
		() =>
			typeof location.state === "object" &&
			location.state !== null &&
			location.state.materialReused === true,
	);
	const [snapshot, setSnapshot] = useState<Material | null>(null);
	const book = useQuery({
		queryKey: materialKeys.book(id),
		queryFn: () => getMaterial(id),
		refetchOnMount: "always",
	});
	useEffect(() => {
		if (notice && location.state?.materialReused === true) {
			const state = { ...location.state };
			delete state.materialReused;
			navigate(location.pathname, { replace: true, state });
		}
	}, [notice, location.pathname, location.state, navigate]);
	useEffect(() => {
		if (
			!snapshot &&
			book.isSuccess &&
			book.isFetchedAfterMount &&
			!book.isFetching
		)
			setSnapshot(book.data);
	}, [
		snapshot,
		book.isSuccess,
		book.isFetchedAfterMount,
		book.isFetching,
		book.data,
	]);
	if (snapshot) return <Reader key={id} book={snapshot} notice={notice} />;
	if (book.isError)
		return <PageError error={book.error} retry={() => void book.refetch()} />;
	return <Loading />;
}
export function MaterialReader() {
	const { id = "" } = useParams();
	return <MaterialOpening key={id} id={id} />;
}
