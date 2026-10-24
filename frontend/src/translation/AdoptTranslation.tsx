import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { getSegment, queries, RequestError } from "../content";
import { matchMaterialSegments } from "../materials/study-api";
import { InlineError } from "../Shared";
import {
	type AdoptionInput,
	adoptTranslation,
	type TranslationResult,
} from "./api";
import { sha256, TranslationSubmission } from "./state";

export type AdoptionSession = {
	version: number;
	listeners: Set<() => void>;
	pending: boolean;
	createNew?: boolean;
	newDraftVersion?: number;
	request: TranslationSubmission<AdoptionInput>;
	saved: string | null;
	uncertain: boolean;
	draft?: {
		translation: string;
		before: string;
		after: string;
		note: string;
		chosen: string;
		useTranslation: boolean;
		useContext: boolean;
		revision: number | null;
	};
};
export function createAdoptionSession(): AdoptionSession {
	return {
		version: 0,
		listeners: new Set(),
		pending: false,
		request: new TranslationSubmission<AdoptionInput>(),
		saved: null,
		uncertain: false,
	};
}

export function adoptionDestinations(
	result: TranslationResult,
	session: AdoptionSession,
): string[] {
	if (session.pending || session.uncertain) return [];
	if (session.saved) return [session.saved];
	if (session.draft || session.createNew) return [];
	return result.adopted_segment_ids;
}
export function beginSeparateAdoption(session: AdoptionSession) {
	session.saved = null;
	session.createNew = true;
	session.draft = undefined;
	session.newDraftVersion = (session.newDraftVersion ?? 0) + 1;
	session.request.clear();
	session.version++;
	for (const listener of session.listeners) listener();
}
export function SavedTranslationDestinations({
	ids,
	onOpenSegment,
	onCreateNew,
	allowCreateNew = true,
	onClose,
}: {
	ids: string[];
	onOpenSegment?: (id: string) => void;
	onCreateNew?: () => void;
	allowCreateNew?: boolean;
	onClose?: () => void;
}) {
	return (
		<section aria-label="已保存的翻译去向">
			<p role="status">
				{ids.length > 1
					? `已保存到 ${ids.length} 个学习片段，选择要打开的去向。`
					: "已保存学习片段。"}
			</p>
			<div className="translation-actions">
				{ids.map((id, index) =>
					onOpenSegment ? (
						<button
							type="button"
							key={id}
							title={id}
							onClick={() => onOpenSegment(id)}
						>
							{ids.length > 1 ? `打开片段 ${index + 1} →` : "打开片段 →"}
						</button>
					) : (
						<Link key={id} title={id} to={`/segments/${id}`}>
							{ids.length > 1 ? `打开片段 ${index + 1} →` : "打开片段 →"}
						</Link>
					),
				)}
				{allowCreateNew && onCreateNew && (
					<button type="button" onClick={onCreateNew}>
						另存为新片段
					</button>
				)}
				{onClose && (
					<button type="button" onClick={onClose}>
						返回译文
					</button>
				)}
			</div>
		</section>
	);
}

export function AdoptTranslation({
	result,
	session,
	onSaved,
	onOpenSegment,
	onClose,
}: {
	result: TranslationResult;
	session: AdoptionSession;
	onSaved: () => void;
	onOpenSegment?: (id: string) => void;
	onClose: () => void;
}) {
	const client = useQueryClient();
	const [translation, setTranslation] = useState(
		session.draft?.translation ?? result.translation,
	);
	const [before, setBefore] = useState(
		session.draft?.before ?? result.context_before,
	);
	const [after, setAfter] = useState(
		session.draft?.after ?? result.context_after,
	);
	const [note, setNote] = useState(session.draft?.note ?? "");
	const [chosen, setChosen] = useState(session.draft?.chosen ?? "");
	const [useTranslation, setUseTranslation] = useState(
		session.draft?.useTranslation ?? false,
	);
	const [useContext, setUseContext] = useState(
		session.draft?.useContext ?? false,
	);
	useSyncExternalStore(
		(listener) => {
			session.listeners.add(listener);
			return () => {
				session.listeners.delete(listener);
			};
		},
		() => session.version,
	);
	const notify = () => {
		session.version++;
		for (const listener of session.listeners) listener();
	};
	const destinations = adoptionDestinations(result, session);
	const uncertain = session.uncertain;
	const request = useRef(session.request);
	const candidates = useQuery({
		queryKey: [
			"material-segment-matches",
			result.source_id,
			result.material_provenance,
		],
		queryFn: ({ signal }) =>
			matchMaterialSegments(
				result.source_id,
				result.material_provenance,
				signal,
			),
		retry: false,
		enabled: !destinations.length,
	});
	const selected = useQuery({
		queryKey: queries.segment(chosen),
		queryFn: () => getSegment(chosen),
		enabled: !!chosen,
	});
	const [revision, setRevision] = useState<number | null>(
		session.draft?.revision ?? null,
	);
	useEffect(() => {
		if (chosen && selected.data && revision === null) {
			setRevision(selected.data.revision);
			setUseTranslation(!selected.data.translation.trim());
		}
	}, [chosen, selected.data, revision]);
	if (!destinations.length)
		session.draft = {
			translation,
			before,
			after,
			note,
			chosen,
			useTranslation,
			useContext,
			revision,
		};
	const save = useMutation({
		mutationFn: async () => {
			const values = {
				chosen,
				translation,
				before,
				after,
				note,
				useTranslation,
				useContext,
				revision,
			};
			const key = JSON.stringify(values);
			const body = request.current.prepare(key, () => ({
				request_id: crypto.randomUUID(),
				note: chosen ? "" : note,
				...(chosen
					? {
							segment_id: chosen,
							expected_revision: revision,
						}
					: {}),
				...(!chosen || useTranslation ? { translation } : {}),
				...(!chosen || useContext
					? { context_before: before, context_after: after }
					: {}),
				...(!chosen ? { note } : {}),
			}));
			if (chosen) body.text_sha256 = await sha256(result.text);
			session.pending = true;
			notify();
			return adoptTranslation(result.id, body);
		},
		onSuccess: (value) => {
			session.createNew = false;
			session.saved = value.segment.id;
			notify();
			session.uncertain = false;
			notify();
			client.setQueryData(queries.segment(value.segment.id), value.segment);
			void client.invalidateQueries({
				queryKey: queries.segments(result.source_id),
			});
			void client.invalidateQueries({ queryKey: ["catalog"] });
			client.setQueryData<TranslationResult>(
				["translation-result", result.id],
				(old) =>
					old
						? {
								...old,
								adopted_segment_ids: Array.from(
									new Set([...old.adopted_segment_ids, value.segment.id]),
								),
							}
						: old,
			);
			void client.invalidateQueries({
				queryKey: ["translation-result", result.id],
			});
			void client.invalidateQueries({
				queryKey: ["translations", result.material_id],
			});
			void client.invalidateQueries({
				queryKey: ["segment-translations", value.segment.id],
			});
			onSaved();
		},
		onSettled: () => {
			session.pending = false;
			notify();
		},
		onError: (error) => {
			const unknown =
				!(error instanceof RequestError) ||
				error.status === 0 ||
				error.status >= 500;
			session.uncertain = unknown;
			notify();
			if (!unknown) request.current.clear();
		},
	});
	if (destinations.length)
		return (
			<SavedTranslationDestinations
				ids={destinations}
				allowCreateNew={!result.material_deleted}
				onOpenSegment={onOpenSegment}
				onClose={onClose}
				onCreateNew={() => {
					beginSeparateAdoption(session);
					setChosen("");
					setUseTranslation(false);
					setUseContext(false);
					setRevision(null);
				}}
			/>
		);

	return (
		<section aria-label="保存翻译为学习片段">
			<h3>保存学习片段</h3>
			<p>
				<small>可修改译文和语境，原文与出处保持不变。</small>
			</p>
			<InlineError error={candidates.error} />
			{candidates.isPending && <p role="status">正在核对相同出处片段…</p>}
			<label>
				保存到
				<select
					disabled={save.isPending || session.pending || uncertain}
					value={chosen}
					onChange={(event) => {
						setChosen(event.target.value);
						setRevision(null);
						setUseContext(false);
						setUseTranslation(false);
					}}
				>
					<option value="">另存新片段</option>
					{candidates.data?.segments.map((s) => (
						<option key={s.id} value={s.id}>
							已有片段：{s.text.slice(0, 35)}
						</option>
					))}
				</select>
			</label>
			{chosen && (
				<>
					<InlineError error={selected.error} />
					{selected.data && (
						<>
							<p>当前译文：{selected.data.translation || "（空）"}</p>
							<details>
								<summary>当前片段语境</summary>
								<p>前文：{selected.data.context_before || "（空）"}</p>
								<p>后文：{selected.data.context_after || "（空）"}</p>
							</details>
							<label>
								<input
									type="checkbox"
									disabled={save.isPending || session.pending || uncertain}
									checked={useTranslation}
									onChange={(event) => setUseTranslation(event.target.checked)}
								/>
								采用这份译文
							</label>
							<label>
								<input
									type="checkbox"
									disabled={save.isPending || session.pending || uncertain}
									checked={useContext}
									onChange={(event) => setUseContext(event.target.checked)}
								/>
								采用本次语境（原语境默认保留）
							</label>
						</>
					)}
				</>
			)}
			{(!chosen || useTranslation) && (
				<label>
					采用译文
					<textarea
						rows={4}
						maxLength={100000}
						disabled={save.isPending || session.pending || uncertain}
						value={translation}
						onChange={(event) => setTranslation(event.target.value)}
					/>
				</label>
			)}
			{(!chosen || useContext) && (
				<details>
					<summary>采用语境</summary>
					<label>
						前文
						<textarea
							disabled={save.isPending || session.pending || uncertain}
							value={before}
							onChange={(event) => setBefore(event.target.value)}
						/>
					</label>
					<label>
						后文
						<textarea
							disabled={save.isPending || session.pending || uncertain}
							value={after}
							onChange={(event) => setAfter(event.target.value)}
						/>
					</label>
				</details>
			)}
			{!chosen && (
				<label>
					备注（可选）
					<textarea
						disabled={save.isPending || session.pending || uncertain}
						value={note}
						onChange={(event) => setNote(event.target.value)}
					/>
				</label>
			)}
			<InlineError error={save.error} />
			{save.error instanceof RequestError && save.error.status === 409 && (
				<p>
					内容已更新，草稿已保留。
					<button
						type="button"
						onClick={async () => {
							const fresh = await selected.refetch();
							if (fresh.data) setRevision(fresh.data.revision);
						}}
					>
						重新读取当前片段并核对
					</button>
				</p>
			)}
			{uncertain && <p>保存结果尚未核实，重试会核实同一个请求。</p>}
			<div className="translation-actions">
				<button
					type="button"
					disabled={
						save.isPending ||
						session.pending ||
						candidates.isPending ||
						candidates.isError ||
						(!!chosen && (!selected.data || revision === null))
					}
					onClick={() => save.mutate()}
				>
					{save.isPending || session.pending
						? "保存中…"
						: uncertain
							? "核实保存"
							: chosen
								? "确认选用与采用"
								: "确认保存"}
				</button>
				<button
					type="button"
					disabled={save.isPending || session.pending || uncertain}
					onClick={onClose}
				>
					返回译文
				</button>
			</div>
		</section>
	);
}
