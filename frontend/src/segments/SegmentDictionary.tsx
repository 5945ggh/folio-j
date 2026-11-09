import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { Dictionary, type DictionaryControl } from "../dictionary/Dictionary";
import type { DictionaryPassage } from "../dictionary/dictionary-passage";
import { LookupTextContext } from "../dictionary/LookupText";
import { useDictionaryPreferences } from "../dictionary/use-dictionary-preferences";
import type { ReturnDestination } from "../navigation";
import "./segment-dictionary.css";

const ToolContext = createContext<ReactNode>(null);
const DialogLayerContext = createContext<
	((element: HTMLDivElement | null) => void) | undefined
>(undefined);

/** Only the complete, read-only material dialog opts into lookup. */
export function SegmentDictionaryDialogLayer() {
	const mount = useContext(DialogLayerContext);
	return <div className="segment-dictionary-layer" ref={mount} />;
}

export function SegmentDictionaryTool() {
	return useContext(ToolContext);
}

type SelectedText = { text: string; range: Range };

/** Segment-specific lifecycle and placement around the shared lookup module. */
export function SegmentDictionary({
	children,
	available,
	resetKey,
	manageState,
}: {
	children: ReactNode;
	available: boolean;
	resetKey: string;
	manageState: ReturnDestination["state"];
}) {
	const { preferences, updatePreferences, storageFailed } =
		useDictionaryPreferences();
	const control = useRef<DictionaryControl>(null);
	const scope = useRef<HTMLDivElement>(null);
	const [portal, setPortal] = useState<HTMLDivElement | null>(null);
	const [dialogPortal, setDialogPortal] = useState<HTMLDivElement | null>(null);
	const [ready, setReady] = useState(false);
	const [lookupEpoch, setLookupEpoch] = useState(0);
	const onClear = useCallback(() => setLookupEpoch((epoch) => epoch + 1), []);
	const [selected, setSelected] = useState<SelectedText | null>(null);
	const clear = useCallback(() => {
		control.current?.close();
		setSelected(null);
	}, []);
	const mountDialog = useCallback(
		(element: HTMLDivElement | null) => {
			clear();
			onClear();
			setDialogPortal(element);
		},
		[clear, onClear],
	);
	const restoreFocus = useCallback(() => {
		if (dialogPortal?.isConnected) {
			dialogPortal
				.closest("dialog")
				?.querySelector<HTMLElement>(".segment-material-body")
				?.focus({ preventScroll: true });
			return;
		}
		scope.current
			?.querySelector<HTMLElement>(".segment-reader")
			?.focus({ preventScroll: true });
	}, [dialogPortal]);
	const lookup = useCallback((passage: DictionaryPassage) => {
		setSelected(null);
		control.current?.lookup({
			input: { text: passage.text, position: passage.offset },
			anchor: passage.anchor,
			passage,
			highlight(start, end) {
				const range = passage.range(start, end);
				if (!range?.startContainer.isConnected) return;
				CSS.highlights?.set("folio-segment-word", new Highlight(range));
			},
			clear: () => CSS.highlights?.delete("folio-segment-word"),
		});
	}, []);
	// Switching content, opening a modal, or hiding a retained page invalidates
	// pending lookups as well as visible cards.
	// biome-ignore lint/correctness/useExhaustiveDependencies: resetKey identifies the rendered reading context.
	useLayoutEffect(() => {
		control.current?.close();
		setSelected(null);
		onClear();
	}, [available, resetKey, preferences.mode, onClear]);
	useEffect(() => {
		if (!available) return;
		const outside = (event: PointerEvent) => {
			if (!(event.target instanceof Element)) return;
			if (
				event.target.closest(
					".dict-card,.dict-config,.dict-trigger,.segment-dictionary-selection",
				)
			)
				return;
			control.current?.close();
		};
		const scroll = (event: Event) => {
			if (
				event.target instanceof Element &&
				event.target.closest(".dict-card,.dict-config")
			)
				return;
			control.current?.close();
			setSelected(null);
		};
		const key = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			// Editing dialogs own Escape; the read-only dialog first retires its cards.
			if (
				event.target instanceof Element &&
				event.target.closest("dialog") &&
				!dialogPortal?.closest("dialog")?.contains(event.target)
			)
				return;
			if (control.current?.back()) {
				event.preventDefault();
				event.stopImmediatePropagation();
			} else setSelected(null);
		};
		const selection = () => {
			const current = document.getSelection();
			const range = current?.rangeCount ? current.getRangeAt(0) : null;
			const element = range?.startContainer.parentElement?.closest(
				"[data-dictionary-text]",
			);
			const text = (current?.toString() ?? "").normalize("NFC");
			setSelected(
				ready &&
					!current?.isCollapsed &&
					range &&
					element &&
					scope.current?.contains(element) &&
					(element.closest(".segment-reader") ||
						dialogPortal?.closest("dialog")?.contains(element)) &&
					!element.closest(".dict-card,.dict-config,[inert]") &&
					(!element.closest("dialog") ||
						dialogPortal?.closest("dialog")?.contains(element)) &&
					element.contains(range.endContainer) &&
					text.trim() &&
					Array.from(text).length <= 512
					? { text, range: range.cloneRange() }
					: null,
			);
		};
		const modal = (event: Event) => {
			if (event.target instanceof HTMLDialogElement && event.target.open)
				clear();
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("scroll", scroll, true);
		document.addEventListener("keydown", key, true);
		document.addEventListener("selectionchange", selection);
		document.addEventListener("toggle", modal, true);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("scroll", scroll, true);
			document.removeEventListener("keydown", key, true);
			document.removeEventListener("selectionchange", selection);
			document.removeEventListener("toggle", modal, true);
		};
	}, [available, ready, clear, dialogPortal]);
	const context = useMemo(
		() => ({
			mode: preferences.mode,
			enabled: available && ready,
			onLookup: lookup,
			onContentChange: clear,
			lookupEpoch,
		}),
		[preferences.mode, available, ready, lookup, clear, lookupEpoch],
	);
	const tool = available ? (
		<Dictionary
			onClear={onClear}
			storageFailed={storageFailed}
			ref={control}
			portal={dialogPortal ?? portal}
			mode={preferences.mode}
			onMode={(mode) => updatePreferences({ mode })}
			autoExpand={preferences.autoExpand}
			onAutoExpand={(autoExpand) => updatePreferences({ autoExpand })}
			assistedRanking={preferences.assistedRanking}
			onAssistedRanking={(assistedRanking) =>
				updatePreferences({ assistedRanking })
			}
			onReady={setReady}
			onActivate={() => setSelected(null)}
			behindPanel={false}
			opacity={100}
			restoreFocus={restoreFocus}
			manageState={manageState}
			onManage={() => control.current?.close()}
			triggerClassName="dict-trigger segment-tool"
			triggerChildren={
				<>
					<svg
						aria-hidden="true"
						viewBox="0 0 24 24"
						width="20"
						height="20"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="M3 4.5c3.4-1 6.2-.4 9 1.5 2.8-1.9 5.6-2.5 9-1.5v14c-3.4-1-6.2-.4-9 1.5-2.8-1.9-5.6-2.5-9-1.5zM12 6v14M6 8l3 1M6 11l3 1" />
					</svg>
					<span className="segment-tool-mobile-label">查词</span>
					<span className="segment-tool-label">即时查词</span>
				</>
			}
		/>
	) : (
		<button
			type="button"
			className="segment-tool"
			aria-label="即时查词"
			disabled
		>
			<span aria-hidden="true">辞</span>
		</button>
	);
	const box = selected?.range.getBoundingClientRect();
	const surfacePortal = dialogPortal ?? portal;
	return (
		<div className="segment-dictionary-scope" ref={scope}>
			<LookupTextContext value={context}>
				<DialogLayerContext value={mountDialog}>
					<ToolContext value={tool}>{children}</ToolContext>
				</DialogLayerContext>
			</LookupTextContext>
			<div className="segment-dictionary-layer" ref={setPortal} />
			{available &&
				selected &&
				box &&
				surfacePortal &&
				createPortal(
					<button
						type="button"
						className="segment-dictionary-selection"
						style={{
							left: Math.max(8, Math.min(window.innerWidth - 108, box.left)),
							top: Math.max(
								8,
								Math.min(window.innerHeight - 44, box.bottom + 6),
							),
						}}
						onPointerDown={(event) => event.preventDefault()}
						onClick={() => {
							control.current?.lookup({
								input: {
									text: selected.text,
									selection_start: 0,
									selection_end: Array.from(selected.text).length,
								},
								anchor: box,
							});
							setSelected(null);
						}}
					>
						查所选文字
					</button>,
					surfacePortal,
				)}
		</div>
	);
}
