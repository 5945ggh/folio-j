import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type Ref,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import {
	DictionaryCards,
	type LookupLevel,
	type LookupOrigin,
} from "./DictionaryCards";
import {
	dictionaryKey,
	getDictionary,
	importDictionary,
	lookupDictionary,
} from "./dictionary-api";
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
	back: () => boolean;
	isOpen: () => boolean;
};

export function ReaderDictionary({
	ref,
	portal,
	mode,
	onMode,
	onRecord,
	onReady,
	restoreFocus,
}: {
	ref: Ref<DictionaryControl>;
	portal: HTMLElement | null;
	mode: DictionaryMode;
	onMode: (mode: DictionaryMode) => void;
	onRecord: (hit: StudyMarkHit) => void;
	onReady: (ready: boolean) => void;
	restoreFocus: () => void;
}) {
	const client = useQueryClient();
	const [menu, setMenu] = useState(false);
	const [levels, setLevels] = useState<LookupLevel[]>([]);
	const current = useRef(levels);
	const ticket = useRef(0);
	const trigger = useRef<HTMLButtonElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const status = useQuery({
		queryKey: dictionaryKey,
		queryFn: ({ signal }) => getDictionary(signal),
		enabled: menu || mode !== "off",
		retry: false,
		staleTime: 0,
	});
	const ready = status.data?.ready === true;
	useEffect(() => onReady(ready), [onReady, ready]);
	const imported = useMutation({
		mutationFn: importDictionary,
		onSuccess: (data) => {
			client.setQueryData(dictionaryKey, data);
		},
	});
	const publish = (next: LookupLevel[]) => {
		current.current = next;
		setLevels(next);
	};
	const clearCards = () => {
		ticket.current++;
		if (!current.current.length) return false;
		current.current[0]?.origin.clear?.();
		publish([]);
		return true;
	};
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
	const back = () => {
		if (current.current.length > 1) {
			backTo(current.current.length - 2);
			return true;
		}
		if (menu) trigger.current?.focus({ preventScroll: true });
		else if (current.current.length) restoreFocus();
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
		const id = ++ticket.current;
		setMenu(false);
		const keep = current.current
			.slice(0, parent + 1)
			.map((item) => ({ ...item, pending: false, message: "" }));
		const level = {
			id,
			origin,
			matches: [],
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
					status.data?.dictionary_id,
					origin.input,
				],
				queryFn: ({ signal }) => lookupDictionary(origin.input, signal),
				staleTime: 60_000,
				gcTime: 90_000,
				retry: false,
			});
			if (ticket.current !== id) return;
			if (result.matches.length) {
				publish([
					...keep,
					{ ...level, matches: result.matches, pending: false },
				]);
				return;
			}
			message = "这部词典里没有找到这个词。";
		} catch (error) {
			if (ticket.current !== id) return;
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
					clearCards();
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
										onClick={() => {
											close();
											trigger.current?.focus({ preventScroll: true });
										}}
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
										<p>触屏轻点正文。词卡里的日文也可以点开。</p>
									</>
								) : (
									<p>
										导入明镜日汉双解词典的 Yomitan ZIP
										文件，即可点读正文和词卡。
									</p>
								)}
								<input
									type="file"
									ref={input}
									accept=".zip,application/zip"
									aria-label="选择词典 ZIP"
									hidden
									onChange={(e) => {
										const file = e.currentTarget.files?.[0];
										e.currentTarget.value = "";
										if (!file) return;
										const intent = ticket.current;
										imported.mutate(file, {
											onSuccess: () => {
												if (intent !== ticket.current) return;
												if (!ready && mode === "off") setMode("click");
												else {
													close();
													trigger.current?.focus({ preventScroll: true });
												}
											},
										});
									}}
								/>
								<button
									type="button"
									className="dict-import"
									disabled={imported.isPending}
									onClick={() => input.current?.click()}
								>
									{imported.isPending
										? "正在建立词典索引…"
										: status.data?.ready
											? "替换本机词典…"
											: "导入词典…"}
								</button>
								{imported.isError && (
									<p role="alert">{imported.error.message}</p>
								)}
							</section>
						)}
						{levels.length > 0 && (
							<DictionaryCards
								levels={levels}
								title={status.data?.title ?? "本机词典"}
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
