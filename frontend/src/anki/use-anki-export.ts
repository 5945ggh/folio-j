import { useEffect, useRef, useState } from "react";
import { RequestError } from "../content";
import {
	type AnkiExportInput,
	type AnkiExportResponse,
	exportAnkiNote,
} from "./api";
import type { AnkiMaterialContext } from "./context";
import {
	type AnkiConfigOption,
	type AnkiDraftValues,
	buildExportFields,
} from "./draft";

export type ExportSnapshot = {
	config: AnkiConfigOption;
	draft: AnkiDraftValues;
	context: AnkiMaterialContext;
	target: Omit<
		AnkiExportInput,
		"fields" | "install_builtin" | "allow_duplicate"
	>;
};
type Receipt = {
	snapshot: ExportSnapshot;
	response: AnkiExportResponse;
	payload?: AnkiExportInput;
};

/** One user submission, from attachment preparation through explicit Anki confirmations. */
export function useAnkiExport(
	snapshot: ExportSnapshot | null,
	onReceipt: (
		response: AnkiExportResponse,
		submitted: ExportSnapshot,
		sameSnapshot: boolean,
	) => void,
) {
	const current = useRef(snapshot);
	current.current = snapshot;
	const locked = useRef(false);
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const [busy, setBusy] = useState(false);
	const [last, setLast] = useState<Receipt | null>(null);
	const receipt = last?.snapshot === snapshot ? last : null;
	if (last?.payload && !receipt) setLast(null);
	async function send(confirm?: "installation_required" | "duplicate") {
		if (!snapshot || locked.current) return;
		if (confirm && (receipt?.response.status !== confirm || !receipt.payload))
			return;
		locked.current = true;
		setBusy(true);
		let posted = false;
		try {
			const payload: AnkiExportInput =
				confirm && receipt?.payload
					? {
							...receipt.payload,
							install_builtin:
								confirm === "installation_required" ||
								receipt.payload.install_builtin,
							allow_duplicate:
								confirm === "duplicate" || receipt.payload.allow_duplicate,
						}
					: {
							...snapshot.target,
							fields: await buildExportFields(
								snapshot.config,
								snapshot.draft,
								snapshot.context,
							),
							install_builtin: false,
							allow_duplicate: false,
						};
			if (!mounted.current || current.current !== snapshot) return;
			posted = true;
			const response = await exportAnkiNote(payload);
			if (!mounted.current) return;
			const sameSnapshot = current.current === snapshot;
			if (
				!sameSnapshot &&
				response.status !== "created" &&
				response.status !== "unknown"
			)
				return;
			const needsConfirmation =
				response.status === "installation_required" ||
				response.status === "duplicate";
			setLast({
				snapshot,
				response,
				payload: needsConfirmation ? payload : undefined,
			});
			onReceipt(response, snapshot, sameSnapshot);
		} catch (error) {
			if (!mounted.current || (!posted && current.current !== snapshot)) return;
			const uncertain =
				posted &&
				!(
					error instanceof RequestError &&
					error.status >= 400 &&
					error.status < 500
				);
			setLast({
				snapshot,
				response: {
					status: uncertain ? "unknown" : "failed",
					type_created: false,
					media_may_remain: false,
					message: uncertain
						? "发送结果未确认，请先在 Anki 中查看是否已创建。"
						: error instanceof Error
							? error.message
							: "无法准备本次发送。",
				},
			});
		} finally {
			locked.current = false;
			if (mounted.current) setBusy(false);
		}
	}
	return {
		busy,
		send,
		response:
			last?.response.status === "unknown" ? last.response : receipt?.response,
		clear: () => setLast(null),
	};
}
