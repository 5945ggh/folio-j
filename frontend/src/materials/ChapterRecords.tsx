import {
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { InlineError } from "../Shared";
import { getSpeechController } from "../speech/browser";
import type { AdoptionSession } from "../translation/AdoptTranslation";
import type { TranslationResult } from "../translation/api";
import { translationCardPosition } from "../translation/placement";
import type { TranslationSession } from "../translation/state";
import { TranslationPanel } from "../translation/TranslationPanel";
import type { Chapter } from "./api";
import type { ChapterTranslation } from "./chapter-translations-query";
import { StudyPreview, type StudyPreviewProps } from "./StudyPreview";
import "./chapter-records.css";

type Props = Omit<StudyPreviewProps, "onEmphasize" | "embedded"> & {
	chapter: Chapter;
	sourceId: string;
	direction: "horizontal-tb" | "vertical-rl";
	translations: readonly ChapterTranslation[];
	translationsLoading: boolean;
	translationsError: Error | null;
	unavailable: number;
	onRetryTranslations: () => void;
	onEmphasize: (id: string | null, kind?: "segment" | "translation") => void;
	onSaved: () => void;
	onBackToOrigin: (result: TranslationResult) => void;
	adoptionSessions: Map<string, AdoptionSession>;
	translationSessions: Map<string, TranslationSession>;
};

export function ChapterRecords(props: Props) {
	const {
		anchor,
		fixed,
		expanded,
		inactive,
		items,
		translations,
		chapter,
		direction,
		onClose,
		onEmphasize,
	} = props;
	const [tab, setTab] = useState<"segment" | "translation">(
		!fixed && !items.length && translations.length ? "translation" : "segment",
	);
	const [selectedId, setSelectedId] = useState<string | null | undefined>();
	const selected = translations.find(
		(item) =>
			item.identity_sha256 ===
			(selectedId === undefined && !fixed && translations.length === 1
				? translations[0]?.identity_sha256
				: selectedId),
	);
	const element = useRef<HTMLDivElement>(null);
	const nextFocus = useRef<"detail" | string | null>(null);
	const body = useRef<HTMLDivElement>(null);
	const callbacks = useRef({ onEmphasize, onClose });
	callbacks.current = { onEmphasize, onClose };
	const id = useId();
	const speech = getSpeechController();
	const speechState = useSyncExternalStore(
		speech.subscribe,
		speech.getSnapshot,
	);
	const [position, setPosition] =
		useState<ReturnType<typeof translationCardPosition>>();
	useLayoutEffect(() => {
		const destination = nextFocus.current;
		if (!destination) return;
		if (destination === "detail" && !selectedId) return;
		const button =
			destination === "detail"
				? element.current?.querySelector<HTMLButtonElement>(
						".translation-card.embedded > header button",
					)
				: [
						...(element.current?.querySelectorAll<HTMLButtonElement>(
							"[data-translation-id]",
						) ?? []),
					].find((item) => item.dataset.translationId === destination);
		if (button) {
			button.focus({ preventScroll: true });
			nextFocus.current = null;
		}
	}, [selectedId]);
	useLayoutEffect(() => {
		const node = element.current;
		if (!node || inactive) return;
		const playback = speechState.target
			? node
					.closest(".reader-r1")
					?.querySelector<HTMLElement>(".device-speech-bar")
			: null;
		const measure = () => {
			const bottomInset = playback
				? Math.max(76, innerHeight - playback.getBoundingClientRect().top + 12)
				: 76;
			const headerHeight =
				node.offsetHeight - (body.current?.offsetHeight ?? 0);
			setPosition(
				translationCardPosition(
					fixed || expanded ? null : anchor,
					{ width: innerWidth, height: innerHeight },
					{
						width: node.offsetWidth,
						height: headerHeight + (body.current?.scrollHeight ?? 0),
					},
					direction,
					bottomInset,
				),
			);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		if (body.current) {
			observer.observe(body.current);
			for (const child of body.current.children) observer.observe(child);
		}
		if (playback) observer.observe(playback);
		window.addEventListener("resize", measure);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [anchor, fixed, expanded, inactive, direction, speechState]);
	useEffect(() => {
		if (tab !== "translation") return;
		callbacks.current.onEmphasize(
			inactive ? null : (selected?.identity_sha256 ?? null),
			"translation",
		);
		return () => callbacks.current.onEmphasize(null, "translation");
	}, [tab, inactive, selected?.identity_sha256]);
	const changeTab = (next: "segment" | "translation") => {
		setTab(next);
		if (body.current) body.current.scrollTop = 0;
	};
	return (
		<div
			ref={element}
			className={`reader-chapter-records${expanded ? " expanded" : ""}`}
			style={position}
			role="dialog"
			aria-modal="false"
			aria-labelledby={`${id}-title`}
			data-reader-tool=""
			data-reader-panel-side={expanded ? "right" : undefined}
			aria-hidden={inactive || undefined}
			inert={inactive || undefined}
			onKeyDown={(event) => {
				if (
					event.key === "Escape" &&
					!event.defaultPrevented &&
					!event.nativeEvent.isComposing
				) {
					event.preventDefault();
					event.stopPropagation();
					onClose();
				}
			}}
		>
			<header className="reader-study-preview-header">
				<strong id={`${id}-title`}>{fixed ? "本章记录" : "此处记录"}</strong>
				<div className="reader-study-preview-actions">
					<button
						type="button"
						aria-expanded={expanded}
						onClick={expanded ? props.onCollapse : props.onExpand}
					>
						{expanded ? "收起" : "展开阅读"}
					</button>
					<button type="button" aria-label="关闭阅读记录" onClick={onClose}>
						×
					</button>
				</div>
			</header>
			<div className="reader-record-tabs" role="tablist" aria-label="记录类型">
				{(["segment", "translation"] as const).map((kind) => (
					<button
						key={kind}
						id={`${id}-${kind}`}
						role="tab"
						type="button"
						aria-label={kind === "segment" ? "学习片段" : "翻译"}
						aria-selected={tab === kind}
						aria-controls={`${id}-${kind}-panel`}
						onClick={() => changeTab(kind)}
						onKeyDown={(event) => {
							if (
								!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
							)
								return;
							event.preventDefault();
							const next =
								event.key === "Home"
									? "segment"
									: event.key === "End"
										? "translation"
										: kind === "segment"
											? "translation"
											: "segment";
							changeTab(next);
							element.current
								?.querySelector<HTMLElement>(`[id="${id}-${next}"]`)
								?.focus();
						}}
					>
						{kind === "segment" ? "学习片段" : "翻译"}
						<span>
							{kind === "segment" ? items.length : translations.length}
						</span>
					</button>
				))}
			</div>
			<div ref={body} className="reader-record-body">
				<div
					id={`${id}-segment-panel`}
					role="tabpanel"
					aria-labelledby={`${id}-segment`}
					hidden={tab !== "segment"}
				>
					<StudyPreview
						{...props}
						embedded
						inactive={inactive || tab !== "segment"}
						onEmphasize={(value) => onEmphasize(value, "segment")}
					/>
				</div>
				<div
					id={`${id}-translation-panel`}
					role="tabpanel"
					aria-labelledby={`${id}-translation`}
					hidden={tab !== "translation"}
				>
					{selected ? (
						<TranslationPanel
							key={selected.identity_sha256}
							embedded
							initialResultId={selected.result_id}
							materialId={chapter.material_id}
							sourceId={props.sourceId}
							target={{ reference: selected.material_provenance, chapter }}
							visible={!inactive && tab === "translation"}
							adoptionSessions={props.adoptionSessions}
							translationSessions={props.translationSessions}
							onSaved={props.onSaved}
							onOpenSegment={props.onOpen}
							onBackToOrigin={props.onBackToOrigin}
							onClose={() => {
								nextFocus.current = selected.identity_sha256;
								setSelectedId(null);
							}}
						/>
					) : (
						<div className="reader-record-translations">
							{props.translationsLoading && (
								<p role="status">正在读取本章翻译…</p>
							)}
							<InlineError error={props.translationsError} />
							{props.translationsError && (
								<button type="button" onClick={props.onRetryTranslations}>
									重试读取本章翻译
								</button>
							)}
							{!props.translationsLoading &&
								!props.translationsError &&
								translations.length === 0 && (
									<p>还没有留存的翻译。选择原文后点击翻译即可。</p>
								)}
							{props.unavailable > 0 && (
								<p role="status">有 {props.unavailable} 处翻译暂时无法定位。</p>
							)}
							{translations.map((item) => (
								<button
									className="reader-record-translation"
									data-translation-id={item.identity_sha256}
									key={item.identity_sha256}
									type="button"
									onClick={() => {
										nextFocus.current = "detail";
										setSelectedId(item.identity_sha256);
									}}
									onMouseEnter={() =>
										onEmphasize(item.identity_sha256, "translation")
									}
									onMouseLeave={() => onEmphasize(null, "translation")}
									onFocus={() =>
										onEmphasize(item.identity_sha256, "translation")
									}
									onBlur={() => onEmphasize(null, "translation")}
								>
									<span lang="ja">{item.excerpt}</span>
									<span>{item.translation_excerpt}</span>
									<small>
										{item.target_language} ·{" "}
										{item.result_count > 1
											? `${item.result_count} 份译文`
											: "已留存"}
									</small>
								</button>
							))}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
