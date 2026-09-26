import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "./api/client";
import {
	errorMessage,
	getSegment,
	getSource,
	queries,
	requireData,
	type SegmentFields,
} from "./content";
import { SegmentForm } from "./Forms";
import {
	ConfirmDialog,
	dateLabel,
	InlineError,
	Loading,
	PageError,
	Shell,
} from "./Shared";

function DetailField({
	label,
	value,
	lang,
}: {
	label: string;
	value: string;
	lang?: string;
}) {
	return value ? (
		<div className="detail-field">
			<h3>{label}</h3>
			<p lang={lang}>{value}</p>
		</div>
	) : null;
}
export function SegmentDetail() {
	const { id = "" } = useParams();
	const navigate = useNavigate();
	const client = useQueryClient();
	const activeId = useRef<string | null>(id);
	activeId.current = id;
	useEffect(() => {
		return () => {
			activeId.current = null;
		};
	}, []);
	const [editing, setEditing] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const segment = useQuery({
		queryKey: queries.segment(id),
		queryFn: () => getSegment(id),
	});
	const source = useQuery({
		queryKey: queries.source(segment.data?.source_id ?? ""),
		queryFn: () => getSource(segment.data?.source_id ?? ""),
		enabled: segment.isSuccess,
	});
	const update = useMutation({
		mutationFn: async (fields: SegmentFields) => {
			const body = segment.data?.text_locked_at
				? {
						translation: fields.translation,
						context_before: fields.context_before,
						context_after: fields.context_after,
						transcription: fields.transcription,
						note: fields.note,
						source_ref: fields.source_ref,
					}
				: fields;
			const { data, error, response } = await api.PATCH(
				"/api/segments/{segment_id}",
				{ params: { path: { segment_id: id } }, body },
			);
			return requireData(data, error, response.status);
		},
		onSuccess: () => {
			if (activeId.current === id) setEditing(false);
			void client.invalidateQueries({ queryKey: queries.segment(id) });
			if (segment.data)
				void client.invalidateQueries({
					queryKey: queries.segments(segment.data.source_id),
				});
		},
	});
	const remove = useMutation({
		mutationFn: async () => {
			const { error, response } = await api.DELETE(
				"/api/segments/{segment_id}",
				{ params: { path: { segment_id: id } } },
			);
			if (error || !response.ok) throw errorMessage(error, response.status);
		},
		onSuccess: () => {
			if (segment.data) {
				void client.invalidateQueries({
					queryKey: queries.segments(segment.data.source_id),
				});
				void client.invalidateQueries({
					queryKey: queries.source(segment.data.source_id),
				});
			}
			void client.invalidateQueries({ queryKey: queries.sources });
			if (activeId.current === id)
				navigate(segment.data ? `/sources/${segment.data.source_id}` : "/");
		},
	});
	if (segment.isPending) return <Loading />;
	if (segment.isError)
		return (
			<PageError error={segment.error} retry={() => void segment.refetch()} />
		);
	const current = segment.data;
	return (
		<Shell>
			<nav className="breadcrumb" aria-label="位置">
				<Link to="/">来源目录</Link>
				<span aria-hidden="true">/</span>
				<Link to={`/sources/${current.source_id}`}>
					{source.data?.title ?? "来源"}
				</Link>
				<span aria-hidden="true">/</span>
				<span aria-current="page">片段</span>
			</nav>
			<div className="page-heading">
				<div>
					<p className="eyebrow">SEGMENT / READING</p>
					<h1>片段阅读</h1>
					<p>
						{source.data?.title ?? "来源加载中"}
						{current.source_ref ? ` · ${current.source_ref}` : ""}
					</p>
				</div>
				<button
					className="button secondary"
					type="button"
					onClick={() => {
						update.reset();
						setEditing(!editing);
					}}
				>
					编辑片段
				</button>
			</div>
			{editing ? (
				<section className="form-section" aria-label="编辑片段">
					<SegmentForm
						key={current.updated_at}
						initial={current}
						onSave={(fields) => update.mutate(fields)}
						onCancel={() => setEditing(false)}
						pending={update.isPending}
						error={update.error}
						submitLabel="保存更改"
					/>
				</section>
			) : (
				<article className="reading-sheet">
					<div className="reading-meta">
						目标原文 <span>{dateLabel(current.created_at)} 保存</span>
					</div>
					<p className="original-text" lang="ja">
						{current.text}
					</p>
					{current.translation && (
						<DetailField label="译文" value={current.translation} />
					)}
					{(current.context_before ||
						current.context_after ||
						current.transcription ||
						current.note ||
						current.source_ref) && (
						<details className="reading-more">
							<summary>补充资料</summary>
							<DetailField
								label="前文"
								value={current.context_before}
								lang="ja"
							/>
							<DetailField
								label="后文"
								value={current.context_after}
								lang="ja"
							/>
							<DetailField
								label="听写"
								value={current.transcription}
								lang="ja"
							/>
							<DetailField label="具体出处" value={current.source_ref} />
							<DetailField label="个人管理备注" value={current.note} />
						</details>
					)}
				</article>
			)}
			<div className="danger-zone">
				<button
					className="text-danger"
					type="button"
					onClick={() => setDeleting(true)}
				>
					删除此片段
				</button>
			</div>
			{deleting && (
				<ConfirmDialog
					titleId="delete-segment-title"
					onClose={() => setDeleting(false)}
				>
					<p className="eyebrow">删除确认</p>
					<h2 id="delete-segment-title">删除这个片段？</h2>
					<blockquote lang="ja">
						{current.text.slice(0, 140)}
						{current.text.length > 140 ? "…" : ""}
					</blockquote>
					<p>
						删除后将从「{source.data?.title ?? "所属来源"}
						」中隐藏，来源本身及其他片段保留。无法从页面恢复。
					</p>
					<InlineError error={remove.error} />
					<div className="actions">
						<button
							className="button danger"
							type="button"
							disabled={remove.isPending}
							onClick={() => remove.mutate()}
						>
							{remove.isPending ? "删除中…" : "确认删除"}
						</button>
						<button
							className="button secondary"
							type="button"
							disabled={remove.isPending}
							onClick={() => setDeleting(false)}
						>
							取消
						</button>
					</div>
				</ConfirmDialog>
			)}
		</Shell>
	);
}
