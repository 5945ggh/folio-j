import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type Ref,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { RequestError } from "../content";
import type { ReturnDestination } from "../navigation";
import {
	DictionaryCards,
	type LookupLevel,
	type LookupOrigin,
} from "./DictionaryCards";
import {
	type DictionaryStatus,
	dictionaryKey,
	getDictionary,
	lookupDictionary,
	subscribeDictionaryLibrary,
} from "./dictionary-api";
import { dictionaryPages } from "./dictionary-pages";
import { MIN_DICTIONARY_OPACITY } from "./preferences";
import type {
	ReaderLookupHit,
	StudyMarkHit,
	StudySelection,
} from "./reader-study";
import "./dictionary.css";

export type DictionaryMode = "off" | "click" | "hover";
export type DictionaryControl = {
	lookup: (hit: ReaderLookupHit | null) => void;
	selection: (value: StudySelection) => void;
	close: () => boolean;
	dismissMenu: () => void;
	back: () => boolean;
	isOpen: () => boolean;
};

export function ReaderDictionary({
	ref,
	onActivate,
	behindPanel,
	portal,
	mode,
	onMode,
	onRecord,
	onReady,
	opacity,
	onOpacity,
	restoreFocus,
	manageState,
	onManage,
}: {
	ref: Ref<DictionaryControl>;
	onActivate: () => void;
	behindPanel: boolean;
	portal: HTMLElement | null;
	mode: DictionaryMode;
	onMode: (mode: DictionaryMode) => void;
	onRecord: (hit: StudyMarkHit) => void;
	onReady: (ready: boolean) => void;
	opacity: number;
	onOpacity: (value: number) => void;
	restoreFocus: () => void;
	manageState: ReturnDestination["state"];
	onManage: () => void;
}) {
	const client = useQueryClient();
	const [menu, setMenu] = useState(false);
	const [levels, setLevels] = useState<LookupLevel[]>([]);
	const [cardDictionary, setCardDictionary] = useState<DictionaryStatus>();
	const [notice, setNotice] = useState("");
	const current = useRef(levels);
	const ticket = useRef(0);
	const trigger = useRef<HTMLButtonElement>(null);
	const status = useQuery({
		queryKey: dictionaryKey,
		queryFn: ({ signal }) => getDictionary(signal),
		enabled: menu || mode !== "off",
		refetchOnWindowFocus: true,
		retry: false,
		staleTime: 0,
	});
	const ready = status.data?.ready === true;
	useEffect(() => onReady(ready), [onReady, ready]);
	const publish = useCallback((next: LookupLevel[]) => {
		current.current = next;
		setLevels(next);
	}, []);
	const clearCards = useCallback(() => {
		ticket.current++;
		if (!current.current.length) return false;
		current.current[0]?.origin.clear?.();
		publish([]);
		return true;
	}, [publish]);
	const selection = status.data?.dictionary_id;
	useEffect(() => {
		// A visible card and its nested lookup stack belong to one dictionary.
		if (cardDictionary?.dictionary_id !== selection) clearCards();
	}, [selection, cardDictionary?.dictionary_id, clearCards]);
	useEffect(() => subscribeDictionaryLibrary(client), [client]);
	const close = () => {
		if (menu) setMenu(false);
		return clearCards() || menu;
	};
	const backTo = (depth: number, index?: number) => {
		ticket.current++;
		publish(
			current.current.slice(0, depth + 1).map((level, i) => ({
				...level,
				index: i === depth ? (index ?? level.index) : level.index,
				pending: false,
				message: "",
			})),
		);
		if (index === undefined)
			requestAnimationFrame(() => {
				portal
					?.querySelector<HTMLElement>(`.dict-card[data-depth="${depth}"] h2`)
					?.focus({ preventScroll: true });
			});
	};
	const closeMenu = () => {
		setMenu(false);
		trigger.current?.focus({ preventScroll: true });
	};
	const back = () => {
		if (menu) {
			closeMenu();
			return true;
		}
		if (current.current.length > 1) {
			backTo(current.current.length - 2);
			return true;
		}
		if (current.current.length) restoreFocus();
		return close();
	};
	useEffect(
		() => () => {
			ticket.current++;
			current.current[0]?.origin.clear?.();
		},
		[],
	);
	const search = async (origin: LookupOrigin, parent: number) => {
		onActivate();
		const selected = client.getQueryData<DictionaryStatus>(dictionaryKey);
		if (!selected?.ready || !selected.dictionary_id) {
			setNotice("请先在设置中选择可用词典。");
			setMenu(true);
			return;
		}
		if (
			parent >= 0 &&
			cardDictionary?.dictionary_id !== selected.dictionary_id
		) {
			clearCards();
			setNotice("当前词典已变化，请重新点击原文查词。");
			setMenu(true);
			return;
		}
		const id = ++ticket.current;
		setCardDictionary(selected);
		setNotice("");
		setMenu(false);
		const keep = current.current
			.slice(0, parent + 1)
			.map((item) => ({ ...item, pending: false, message: "" }));
		const level = {
			id,
			origin,
			pages: [],
			index: 0,
			pending: true,
			message: "",
		};
		if (parent < 0) {
			current.current[0]?.origin.clear?.();
			publish([level]);
		} else {
			publish(
				keep.map((item, i) =>
					i === parent ? { ...item, pending: true } : item,
				),
			);
		}
		let message = "";
		try {
			const result = await client.fetchQuery({
				queryKey: [
					"dictionary",
					"lookup",
					selected.dictionary_id,
					origin.input,
				],
				queryFn: ({ signal }) =>
					lookupDictionary(
						{ ...origin.input, expected_dictionary_id: selected.dictionary_id },
						signal,
					),
				staleTime: 60_000,
				gcTime: 90_000,
				retry: false,
			});
			if (
				ticket.current !== id ||
				client.getQueryData<DictionaryStatus>(dictionaryKey)?.dictionary_id !==
					selected.dictionary_id
			)
				return;
			if (
				result.matches.some(
					(match) => match.dictionary_id !== selected.dictionary_id,
				)
			)
				throw new RequestError("当前词典已变化。", 409);
			if (result.matches.length) {
				publish([
					...keep,
					{ ...level, pages: dictionaryPages(result.matches), pending: false },
				]);
				return;
			}
			message = "这部词典里没有找到这个词。";
		} catch (error) {
			if (ticket.current !== id) return;
			if (error instanceof RequestError && error.status === 409) {
				clearCards();
				setNotice("当前词典已变化，请重新点击原文查词。");
				setMenu(true);
				await status.refetch();
				return;
			}
			message =
				error instanceof Error ? error.message : "查词失败，请再试一次。";
		}
		publish(
			parent < 0
				? [{ ...level, pending: false, message }]
				: keep.map((item, i) => (i === parent ? { ...item, message } : item)),
		);
	};
	useImperativeHandle(ref, () => ({
		lookup(hit) {
			if (!hit) {
				clearCards();
				return;
			}
			void search(
				{
					input: { text: hit.text, position: hit.offset, tokens: hit.tokens },
					anchor: hit.anchor,
					record: hit.studyHit,
					highlight: hit.highlight,
					clear: hit.clearHighlight,
				},
				-1,
			);
		},
		selection(value) {
			const text = value.target.reference.ranges.map((r) => r.exact).join("");
			void search(
				{
					input: {
						text,
						selection_start: 0,
						selection_end: Array.from(text).length,
					},
					anchor: value.anchor,
				},
				-1,
			);
		},
		close,
		dismissMenu: () => setMenu(false),
		back,
		isOpen: () => menu || current.current.length > 0,
	}));
	const setMode = (value: DictionaryMode) => {
		close();
		onMode(value);
		trigger.current?.focus({ preventScroll: true });
	};
	const finish = () => {
		close();
		restoreFocus();
	};
	return (
		<>
			<button
				type="button"
				ref={trigger}
				className="dict-trigger"
				aria-label="即时查词"
				data-tooltip={
					mode === "off"
						? "即时查词"
						: mode === "click"
							? "点击查词已开启"
							: "Shift 指向查词已开启"
				}
				aria-pressed={ready && mode !== "off"}
				aria-expanded={menu}
				onClick={() => {
					onActivate();
					setMenu(!menu);
				}}
			>
				<svg
					viewBox="0 0 24 24"
					width="22"
					height="22"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M3 4.5c3.4-1 6.2-.4 9 1.5 2.8-1.9 5.6-2.5 9-1.5v14c-3.4-1-6.2-.4-9 1.5-2.8-1.9-5.6-2.5-9-1.5zM12 6v14M6 8l3 1M6 11l3 1" />
				</svg>
			</button>
			{portal &&
				createPortal(
					<>
						{menu && (
							<section
								className="dict-config"
								data-reader-tool=""
								role="dialog"
								aria-label="即时查词设置"
							>
								<header>
									<div>
										<h2>即时查词</h2>
									</div>
									<button
										type="button"
										aria-label="关闭查词设置"
										onClick={closeMenu}
									>
										×
									</button>
								</header>
								{status.isPending ? (
									<p role="status">正在读取词典…</p>
								) : status.isError ? (
									<p role="alert">
										{status.error.message}{" "}
										<button type="button" onClick={() => void status.refetch()}>
											重试
										</button>
									</p>
								) : status.data?.ready ? (
									<>
										<p className="dict-installed">
											<span aria-hidden="true">辞</span>
											{status.data.title}
										</p>
										<fieldset className="dict-modes" aria-label="查词方式">
											{(
												[
													["off", "关闭"],
													["click", "点击查词"],
													["hover", "Shift 悬浮"],
												] as const
											).map(([value, label]) => (
												<button
													type="button"
													key={value}
													aria-pressed={mode === value}
													onClick={() => setMode(value)}
												>
													{label}
												</button>
											))}
										</fieldset>
										<label className="dict-opacity">
											<span>浮窗背景不透明度</span>
											<output>{opacity}%</output>
											<input
												type="range"
												aria-label="浮窗背景不透明度"
												min={MIN_DICTIONARY_OPACITY}
												max="100"
												step="1"
												value={opacity}
												onChange={(event) =>
													onOpacity(Number(event.target.value))
												}
											/>
										</label>
										<p>
											词卡、学习片段、翻译与记录列表共用，与阅读界面设置同步。
										</p>
									</>
								) : (
									<p>在设置中导入并选择词典，即可点读正文和词卡。</p>
								)}
								<Link
									className="dict-import"
									to="/settings?section=dictionary"
									state={manageState}
									onClick={onManage}
								>
									管理词典
								</Link>
								{notice && <p role="status">{notice}</p>}
							</section>
						)}
						{levels.length > 0 &&
							cardDictionary?.dictionary_id === selection && (
								<DictionaryCards
									behindPanel={behindPanel}
									key={levels[0]?.id}
									mode={mode}
									levels={levels}
									opacity={opacity}
									title={cardDictionary?.title ?? "本机词典"}
									nested={(depth, origin) => void search(origin, depth)}
									choose={backTo}
									backTo={backTo}
									close={finish}
									onRecord={(hit) => {
										close();
										onRecord(hit);
									}}
								/>
							)}
					</>,
					portal,
				)}
		</>
	);
}
