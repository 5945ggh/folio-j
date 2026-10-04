import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router";
import { InlineError } from "../Shared";
import { importMaterial, listMaterials, materialKeys } from "./api";
export function MaterialList({ sourceId }: { sourceId: string }) {
	const navigate = useNavigate();
	const client = useQueryClient();
	const current = useRef<string | null>(sourceId);
	useEffect(
		() => () => {
			current.current = null;
		},
		[],
	);
	current.current = sourceId;
	const books = useQuery({
		queryKey: materialKeys.list(sourceId),
		queryFn: () => listMaterials(sourceId),
	});
	const upload = useMutation({
		mutationFn: (file: File) => importMaterial(sourceId, file),
		onSuccess: ({ material, reused }) => {
			void client.invalidateQueries({ queryKey: materialKeys.list(sourceId) });
			if (current.current === sourceId)
				navigate(`/materials/${material.id}`, {
					state: { materialReused: reused },
				});
		},
	});
	return (
		<section className="list-section" aria-label="阅读材料">
			<div className="section-heading">
				<h2>阅读材料</h2>
				<label className="button secondary material-upload">
					{upload.isPending ? "导入中…" : "导入 EPUB"}
					<input
						type="file"
						accept=".epub,application/epub+zip"
						disabled={upload.isPending}
						onChange={(e) => {
							const file = e.target.files?.[0];
							if (file) upload.mutate(file);
							e.target.value = "";
						}}
					/>
				</label>
			</div>
			<InlineError error={upload.error} />
			{books.isPending ? (
				<p>正在加载材料…</p>
			) : books.isError ? (
				<>
					<InlineError error={books.error} />
					<button
						className="button secondary"
						type="button"
						onClick={() => void books.refetch()}
					>
						重试
					</button>
				</>
			) : books.data.length === 0 ? (
				<div className="empty-state">
					<p>导入 EPUB，保留原书目录、插图与注音，随时继续阅读。</p>
				</div>
			) : (
				<div className="source-list">
					{books.data.map((book) => (
						<Link
							className="source-row"
							key={book.id}
							to={`/materials/${book.id}`}
						>
							<h3>{book.title}</h3>
							<span aria-hidden="true">→</span>
						</Link>
					))}
				</div>
			)}
		</section>
	);
}
