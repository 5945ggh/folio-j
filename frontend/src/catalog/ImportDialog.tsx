import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { api } from "../api/client";
import {
	listSources,
	queries,
	requireData,
	type SourceFields,
} from "../content";
import { SourceForm } from "../Forms";
import { importMaterial, materialKeys } from "../materials/api";
import { ConfirmDialog, InlineError } from "../Shared";
import { catalogKeys } from "./api";
export function ImportDialog({
	sourceId,
	close,
}: {
	sourceId?: string;
	close: () => void;
}) {
	const client = useQueryClient();
	const navigate = useNavigate();
	const location = useLocation();
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const [selected, setSelected] = useState(sourceId ?? "");
	const [newSource, setNewSource] = useState(false);
	const [created, setCreated] = useState<string | null>(null);
	const [file, setFile] = useState<File | null>(null);
	const sources = useQuery({ queryKey: queries.sources, queryFn: listSources });
	const create = useMutation({
		mutationFn: async (fields: SourceFields) => {
			const { data, error, response } = await api.POST("/api/sources", {
				body: fields,
			});
			return requireData(data, error, response.status);
		},
		onSuccess: (source) => {
			void client.invalidateQueries({ queryKey: queries.sources });
			void client.invalidateQueries({ queryKey: catalogKeys.all });
			if (mounted.current) {
				setSelected(source.id);
				setCreated(source.title);
				setNewSource(false);
			}
		},
	});
	const upload = useMutation({
		mutationFn: () => {
			if (!file || !selected) throw new Error("请选择 EPUB 和所属 Source。");
			return importMaterial(selected, file);
		},
		onSuccess: ({ material, reused }) => {
			void client.invalidateQueries({ queryKey: catalogKeys.all });
			void client.invalidateQueries({ queryKey: materialKeys.list(selected) });
			void client.invalidateQueries({ queryKey: queries.source(selected) });
			if (mounted.current)
				navigate(`/materials/${material.id}`, {
					state: {
						materialReused: reused,
						returnTo: {
							to: `${location.pathname}${location.search}`,
							label: sourceId ? "Source" : "素材库",
						},
					},
				});
		},
	});
	return (
		<ConfirmDialog
			className="import-dialog"
			titleId="import-title"
			onClose={close}
			restoreFocusId="library-add"
		>
			<div className="section-heading">
				<h2 id="import-title">添加书籍</h2>
				<button
					type="button"
					className="button secondary"
					data-dialog-cancel
					onClick={close}
				>
					关闭
				</button>
			</div>
			<p className="field-help">导入单本 EPUB，并明确选择它所属的 Source。</p>
			<label className="field">
				<span>EPUB 文件</span>
				<input
					type="file"
					accept=".epub,application/epub+zip"
					disabled={upload.isPending}
					onChange={(event) => setFile(event.target.files?.[0] ?? null)}
				/>
			</label>
			{!newSource ? (
				<>
					<label className="field">
						<span>所属 Source</span>
						<select
							required
							value={selected}
							disabled={upload.isPending || Boolean(sourceId)}
							onChange={(event) => setSelected(event.target.value)}
						>
							<option value="">请选择 Source</option>
							{sources.data?.map((source) => (
								<option key={source.id} value={source.id}>
									{source.title}
								</option>
							))}
						</select>
					</label>
					{!sourceId && (
						<button
							className="button secondary"
							type="button"
							disabled={upload.isPending}
							onClick={() => {
								create.reset();
								setNewSource(true);
							}}
						>
							新建 Source
						</button>
					)}
				</>
			) : (
				<SourceForm
					onSave={(fields) => create.mutate(fields)}
					onCancel={() => setNewSource(false)}
					pending={create.isPending}
					error={create.error}
					submitLabel="保存 Source 并继续"
				/>
			)}
			{created && (
				<p role="status">
					已保存 Source「{created}」。导入失败时可保留此归属重试。
				</p>
			)}
			{sources.isError && <InlineError error={sources.error} />}
			<InlineError error={upload.error} />
			<div className="actions">
				<button
					className="button primary"
					type="button"
					disabled={!file || !selected || newSource || upload.isPending}
					onClick={() => upload.mutate()}
				>
					{upload.isPending ? "导入中…" : "导入并阅读"}
				</button>
				<button type="button" className="button secondary" onClick={close}>
					取消
				</button>
			</div>
			{upload.isPending && (
				<p className="field-help">
					关闭窗口不会撤销已经提交的导入，完成后书籍仍会出现在目录。
				</p>
			)}
		</ConfirmDialog>
	);
}
