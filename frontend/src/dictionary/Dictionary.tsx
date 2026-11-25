import {
	isCancelledError,
	queryOptions,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import {
	type ReactNode,
	type Ref,
	useCallback,
	useEffect,
	useEffectEvent,
	useId,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { RequestError } from "../content";
import {
	DICTIONARY_POPOVER_MOTION_MS,
	useReaderPresence,
} from "../materials/motion";
import type { ReturnDestination } from "../navigation";
import {
	DictionaryCards,
	type LookupLevel,
	type LookupOrigin,
} from "./DictionaryCards";
import {
	dictionaryIdentity,
	dictionaryKey,
	getDictionary,
	lookupDictionary,
	subscribeDictionaryLibrary,
} from "./dictionary-api";
import { dictionaryPages } from "./dictionary-pages";
import type { DictionaryMode } from "./preferences";
import "./dictionary.css";

export type { LookupOrigin } from "./DictionaryCards";

export type DictionaryControl = {
	lookup: (origin: LookupOrigin | null) => void;
	close: () => boolean;
	dismissMenu: () => void;
	back: () => boolean;
	isOpen: () => boolean;
};

const statusQuery = queryOptions({
	queryKey: dictionaryKey,
	queryFn: ({ signal }) => getDictionary(signal),
	retry: false,
	staleTime: 0,
});

export function Dictionary({
	ref,
	onActivate,
	onClear,
	behindPanel,
	portal,
	mode,
	onMode,
	autoExpand,
	onAutoExpand,
	assistedRanking,
	onAssistedRanking,
	onReady,
	opacity,
	restoreFocus,
	manageState,
	onManage,
	triggerClassName = "dict-trigger",
	triggerChildren,
	storageFailed = false,
}: {
	ref: Ref<DictionaryControl>;
	onActivate: () => void;
	onClear?: () => void;
	behindPanel: boolean;
	portal: HTMLElement | null;
	mode: DictionaryMode;
	onMode: (mode: DictionaryMode) => void;
	autoExpand: boolean;
	onAutoExpand: (value: boolean) => void;
	assistedRanking: boolean;
	onAssistedRanking: (value: boolean) => void;
	onReady: (ready: boolean) => void;
	opacity: number;
	restoreFocus: () => void;
	manageState: ReturnDestination["state"];
	onManage: () => void;
	triggerClassName?: string;
	triggerChildren?: ReactNode;
	storageFailed?: boolean;
}) {
	const client = useQueryClient();
	const inputId = useId();
	const cleared = useRef(onClear);
	cleared.current = onClear;
	const [menu, setMenu] = useState(false);
	const [levels, setLevels] = useState<LookupLevel[]>([]);
	const [cardDictionary, setCardDictionary] = useState<{
		id: string | null;
		title: string | null;
	}>();
	const [notice, setNotice] = useState("");
	const current = useRef(levels);
	const ticket = useRef(0);
	const options = useRef({ mode, autoExpand, assistedRanking });
	const appliedOptions = useRef({ mode, autoExpand, assistedRanking });
	options.current = { mode, autoExpand, assistedRanking };
	const trigger = useRef<HTMLButtonElement>(null);
	const config = useRef<HTMLElement>(null);
	const menuPresence = useReaderPresence(
		menu ? true : null,
		DICTIONARY_POPOVER_MOTION_MS,
	);
	useEffect(() => {
		if (!menu) return;
		const node = config.current;
		if (node && !node.contains(document.activeElement))
			node.focus({ preventScroll: true });
	}, [menu]);
	const status = useQuery({
		...statusQuery,
		enabled: menu || mode !== "off" || levels.length > 0,
		refetchOnWindowFocus: true,
	});
	const selection = status.isError
		? undefined
		: dictionaryIdentity(status.data);
	const ready = selection !== undefined;
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
		cleared.current?.();
		return true;
	}, [publish]);
	useLayoutEffect(() => {
		// A visible card and its nested lookup stack belong to one dictionary.
		if (cardDictionary && cardDictionary.id !== selection) clearCards();
	}, [selection, cardDictionary, clearCards]);
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
	useLayoutEffect(
		() => () => {
			ticket.current++;
			current.current[0]?.origin.clear?.();
		},
		[],
	);
	const search = async (
		origin: LookupOrigin,
		parent: number,
		refresh?: LookupLevel,
	) => {
		if (!refresh) onActivate();
		const getStatus = () =>
			client.getQueryState<typeof status.data>(dictionaryKey);
		let selected = getStatus();
		let identity =
			selected?.status === "success"
				? dictionaryIdentity(selected.data)
				: undefined;
		const manual = parent < 0 && origin.input.selection_start != null;
		// A manual selection can open a card while gesture-based lookup is off.
		const prepare =
			manual && (identity === undefined || (!refresh && mode === "off"));
		if (identity === undefined && !prepare) {
			if (refresh) clearCards();
			else setMenu(true);
			return;
		}
		if (
			(parent >= 0 || (refresh && cardDictionary)) &&
			cardDictionary?.id !== identity
		) {
			clearCards();
			if (!refresh) {
				setNotice("当前词典已切换，请重新查词。");
				setMenu(true);
			}
			return;
		}
		const snapshot = { mode, autoExpand, assistedRanking };
		const input = {
			...origin.input,
			auto_expand: snapshot.autoExpand,
			assisted_ranking: snapshot.assistedRanking,
		};
		const requestTicket = ++ticket.current;
		if (prepare) setCardDictionary(undefined);
		setNotice("");
		if (!refresh) setMenu(false);
		const keep = current.current
			.slice(0, parent + 1)
			.map((item) => ({ ...item, pending: false, message: "" }));
		const level: LookupLevel = {
			id: refresh?.id ?? requestTicket,
			origin,
			pages: refresh?.pages ?? [],
			index: refresh?.index ?? 0,
			pending: true,
			message: "",
			refresh: refresh ? "pending" : undefined,
		};
		const emptyResult = (message: string): LookupLevel => ({
			...level,
			pages: [],
			index: 0,
			pending: false,
			message,
			refresh: refresh ? "retry" : undefined,
		});
		if (parent < 0) {
			if (refresh) origin.unhighlight?.();
			else current.current[0]?.origin.clear?.();
			publish([level]);
		} else {
			publish(
				keep.map((item, i) =>
					i === parent ? { ...item, pending: true } : item,
				),
			);
		}
		const isCurrentTicket = () =>
			ticket.current === requestTicket &&
			options.current.mode === snapshot.mode &&
			options.current.autoExpand === snapshot.autoExpand &&
			options.current.assistedRanking === snapshot.assistedRanking;
		if (prepare) {
			try {
				await client.fetchQuery(statusQuery);
			} catch (error) {
				if (!isCurrentTicket()) return;
				if (isCancelledError(error)) {
					clearCards();
					return;
				}
				publish([
					emptyResult(
						error instanceof Error ? error.message : "加载词典失败。",
					),
				]);
				return;
			}
			if (!isCurrentTicket()) return;
			selected = getStatus();
			identity =
				selected?.status === "success"
					? dictionaryIdentity(selected.data)
					: undefined;
		}
		if (identity === undefined) {
			publish([emptyResult("词典暂不可用。")]);
			return;
		}
		setCardDictionary({ id: identity, title: selected?.data?.title ?? null });
		const request = { ...input, expected_dictionary_id: identity };
		const isCurrent = () => {
			const latest = getStatus();
			return (
				isCurrentTicket() &&
				latest?.status === "success" &&
				dictionaryIdentity(latest.data) === identity
			);
		};
		let message = "";
		try {
			const result = await client.fetchQuery({
				queryKey: ["dictionary", "lookup", identity, request],
				queryFn: ({ signal }) => lookupDictionary(request, signal),
				staleTime: 60_000,
				gcTime: 90_000,
				retry: false,
			});
			if (!isCurrent()) return;
			if (result.matches.some((match) => match.dictionary_id !== identity))
				throw new RequestError("当前词典已变化。", 409);
			const pages = dictionaryPages(result.matches, result.analyses);
			if (pages.length) {
				publish([
					...keep,
					{ ...level, pages, index: 0, pending: false, refresh: undefined },
				]);
				return;
			}
			message = "未找到可显示的词形信息。";
		} catch (error) {
			if (!isCurrent()) return;
			if (error instanceof RequestError && error.status === 409) {
				clearCards();
				setNotice("当前词典已切换，请重新查词。");
				setMenu(true);
				await status.refetch();
				return;
			}
			message =
				error instanceof Error ? error.message : "查词失败，请再试一次。";
		}
		publish(
			parent < 0
				? [emptyResult(message)]
				: keep.map((item, i) => (i === parent ? { ...item, message } : item)),
		);
	};
	const refreshRoot = () => {
		const root = current.current[0];
		if (root) void search(root.origin, -1, root);
	};
	const refreshForOptions = useEffectEvent(refreshRoot);
	useLayoutEffect(() => {
		const previous = appliedOptions.current;
		appliedOptions.current = { mode, autoExpand, assistedRanking };
		if (previous.mode !== mode) clearCards();
		else if (
			previous.autoExpand !== autoExpand ||
			previous.assistedRanking !== assistedRanking
		)
			refreshForOptions();
	}, [mode, autoExpand, assistedRanking, clearCards]);
	useImperativeHandle(ref, () => ({
		lookup(origin) {
			if (!origin) {
				clearCards();
				return;
			}
			void search(origin, -1);
		},
		close,
		dismissMenu: () => setMenu(false),
		back,
		isOpen: () => menu || current.current.length > 0,
	}));
	const setMode = (value: DictionaryMode) => {
		clearCards();
		onMode(value);
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
				className={triggerClassName}
				aria-label="即时查词"
				data-tooltip={
					mode === "off"
						? "即时查词"
						: mode === "click"
							? "点击查词已开启"
							: "Shift 悬停查词已开启"
				}
				aria-pressed={ready && mode !== "off"}
				aria-expanded={menu}
				onClick={() => {
					onActivate();
					setMenu(!menu);
				}}
			>
				{triggerChildren ?? (
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
				)}
			</button>
			{portal &&
				createPortal(
					<>
						{menuPresence.value && (
							<section
								ref={config}
								className="dict-config"
								data-reader-tool=""
								data-exiting={menuPresence.exiting}
								inert={menuPresence.exiting}
								aria-hidden={menuPresence.exiting || undefined}
								role="dialog"
								tabIndex={-1}
								aria-label="即时查词设置"
								onKeyDown={(event) => {
									if (
										event.key !== "Escape" ||
										event.defaultPrevented ||
										event.nativeEvent.isComposing
									)
										return;
									event.preventDefault();
									event.stopPropagation();
									closeMenu();
								}}
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
									<p role="status">正在加载词典…</p>
								) : status.isError ? (
									<p role="alert">
										{status.error.message}{" "}
										<button type="button" onClick={() => void status.refetch()}>
											重试
										</button>
									</p>
								) : ready ? (
									<>
										<p className="dict-installed">
											<span aria-hidden="true">辞</span>
											{selection === null
												? "未导入离线词典 · 仅显示读音与词形"
												: status.data?.title}
										</p>
										<fieldset className="dict-modes" aria-label="查词方式">
											{(
												[
													["off", "关闭"],
													["click", "点击查词"],
													["hover", "Shift 悬停"],
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
										<div className="dict-lookup-options">
											<div className="dict-lookup-toggle">
												<div className="dict-lookup-name">
													<label htmlFor={`${inputId}-dict-auto-expand`}>
														自动扩展查词
													</label>
													<button
														type="button"
														className="dict-option-help"
														aria-label="自动扩展查词说明"
														aria-describedby={`${inputId}-dict-expand-help`}
														data-tooltip="开启后，点在词语中间，也能查找包含该字的完整词语。"
													>
														<span aria-hidden="true">?</span>
													</button>
												</div>
												<input
													type="checkbox"
													role="switch"
													id={`${inputId}-dict-auto-expand`}
													aria-label="自动扩展查词"
													aria-describedby={`${inputId}-dict-expand-help`}
													aria-checked={autoExpand}
													checked={autoExpand}
													onChange={(event) =>
														onAutoExpand(event.target.checked)
													}
												/>
											</div>
											<p id={`${inputId}-dict-expand-help`} className="sr-only">
												开启后，点在词语中间，也能查找包含该字的完整词语。
											</p>
											<div className="dict-lookup-toggle">
												<div className="dict-lookup-name">
													<label htmlFor={`${inputId}-dict-assisted-ranking`}>
														辅助排序
													</label>
													<button
														type="button"
														className="dict-option-help"
														aria-label="辅助排序说明"
														aria-describedby={`${inputId}-dict-ranking-help`}
														data-tooltip="开启后，结合原文的词形、读音和词性，优先显示更匹配的词条。"
													>
														<span aria-hidden="true">?</span>
													</button>
												</div>
												<input
													type="checkbox"
													role="switch"
													id={`${inputId}-dict-assisted-ranking`}
													aria-label="辅助排序"
													aria-describedby={`${inputId}-dict-ranking-help`}
													aria-checked={assistedRanking}
													checked={assistedRanking}
													onChange={(event) =>
														onAssistedRanking(event.target.checked)
													}
												/>
											</div>
											<p
												id={`${inputId}-dict-ranking-help`}
												className="sr-only"
											>
												开启后，结合原文的词形、读音和词性，优先显示更匹配的词条。
											</p>
										</div>
									</>
								) : (
									<p role="status">
										词典暂不可用。{" "}
										<button type="button" onClick={() => void status.refetch()}>
											重试
										</button>
									</p>
								)}
								<Link
									className="dict-import"
									to="/settings?section=dictionary"
									state={manageState}
									onClick={onManage}
								>
									管理词典
								</Link>
								{storageFailed && (
									<p role="status">
										查词设置仅在本次使用中生效，浏览器保存失败。
									</p>
								)}
								{notice && <p role="status">{notice}</p>}
							</section>
						)}
						{levels.length > 0 &&
							(!cardDictionary || cardDictionary.id === selection) && (
								<DictionaryCards
									behindPanel={behindPanel}
									key={levels[0]?.id}
									mode={mode}
									levels={levels}
									opacity={opacity}
									title={
										cardDictionary?.title ??
										(selection === null ? "读音与词形" : "离线词典")
									}
									hasDictionary={selection !== null}
									nested={(depth, origin) => void search(origin, depth)}
									choose={backTo}
									backTo={backTo}
									close={finish}
									retry={refreshRoot}
									onRecord={(record) => {
										close();
										record();
									}}
								/>
							)}
					</>,
					portal,
				)}
		</>
	);
}
