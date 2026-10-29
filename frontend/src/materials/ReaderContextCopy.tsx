import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { buildContextCopy } from "./context-copy";
import "./context-copy-feedback.css";

type CopyContent = ReturnType<typeof buildContextCopy>;
type CopyFeedback = CopyContent & {
	status: "copied" | "failed";
	serial: number;
};

/** A receipt belongs to the selection that initiated it, including across Reader suspension. */
export function useReaderContextCopy(scope: string | null) {
	const request = useRef(0);
	const currentScope = useRef(scope);
	const [busy, setBusy] = useState(false);
	const [feedback, setFeedback] = useState<CopyFeedback | null>(null);
	const dismiss = useCallback(() => {
		request.current++;
		setBusy(false);
		setFeedback(null);
	}, []);
	useLayoutEffect(() => {
		currentScope.current = scope;
		dismiss();
		return () => {
			request.current++;
		};
	}, [scope, dismiss]);
	const copy = async (content: CopyContent) => {
		if (!scope || currentScope.current !== scope) return;
		const serial = ++request.current;
		setBusy(true);
		setFeedback(null);
		try {
			// Invoke within the click gesture; all text preparation is synchronous and local.
			await navigator.clipboard.writeText(content.text);
			if (serial === request.current)
				setFeedback({ ...content, status: "copied", serial });
		} catch {
			if (serial === request.current)
				setFeedback({ ...content, status: "failed", serial });
		} finally {
			if (serial === request.current) setBusy(false);
		}
	};
	return { copy, busy, feedback, dismiss };
}

export function ContextCopyFeedback({
	feedback,
	onClose,
}: {
	feedback: CopyFeedback;
	onClose: () => void;
}) {
	const text = useRef<HTMLTextAreaElement>(null);
	const close = useRef(onClose);
	close.current = onClose;
	useEffect(() => {
		if (feedback.status !== "copied") return;
		const timer = setTimeout(() => close.current(), 5000);
		return () => clearTimeout(timer);
	}, [feedback]);
	if (feedback.status === "copied")
		return (
			<div className="reader-copy-feedback" role="status" data-reader-tool="">
				<span>
					已复制目标原文与上下文
					{(feedback.beforeTruncated || feedback.afterTruncated) &&
						"，超长语境已标明截断"}
				</span>
				<button type="button" aria-label="关闭复制提示" onClick={onClose}>
					×
				</button>
			</div>
		);
	return (
		<section
			className="reader-copy-feedback reader-copy-fallback"
			role="dialog"
			aria-label="手动复制"
			aria-modal="false"
			data-reader-tool=""
			onKeyDown={(event) => {
				if (event.key === "Escape" && !event.nativeEvent.isComposing) {
					event.preventDefault();
					event.stopPropagation();
					onClose();
				}
			}}
		>
			<header>
				<strong>手动复制</strong>
				<button type="button" aria-label="关闭复制提示" onClick={onClose}>
					×
				</button>
			</header>
			<p role="alert">未能写入剪贴板，可选择下方文本手动复制。</p>
			<textarea
				ref={text}
				aria-label="待复制的文本"
				readOnly
				value={feedback.text}
			/>
			<button type="button" onClick={() => text.current?.select()}>
				选择文本
			</button>
		</section>
	);
}
