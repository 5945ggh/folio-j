import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { returnDestination } from "../navigation";
import { dateLabel, InlineError, Shell } from "../Shared";
import { bookDetailsKey, getBookDetails } from "./api";
import { BookCoverPlaceholder } from "./BookCoverPlaceholder";
import { BookEditDialog } from "./BookEditDialog";
import { statusLabels } from "./Controls";
import "./book-management.css";

export function BookDetailsPage() {
	const { id = "" } = useParams();
	return <BookDetails key={id} id={id} />;
}
function BookDetails({ id }: { id: string }) {
	const location = useLocation();
	const back = returnDestination(location.state, {
		to: "/materials",
		label: "素材库",
	});
	const details = useQuery({
		queryKey: bookDetailsKey(id),
		queryFn: () => getBookDetails(id),
	});
	const [editing, setEditing] = useState(false);
	const [failedCover, setFailedCover] = useState<string | null>(null);
	const [coverAttempt, setCoverAttempt] = useState(0);
	const book = details.data;
	return (
		<Shell className="book-details-page">
			<header className="book-details-toolbar">
				<Link className="book-details-back" to={back.to} state={back.state}>
					<span aria-hidden="true">←</span> {back.label}
				</Link>
				<span className="book-details-toolbar-divider" aria-hidden="true" />
				<span>书籍详情</span>
			</header>
			{details.isPending ? (
				<p role="status">正在加载书籍信息…</p>
			) : details.isError ? (
				<div className="state-card">
					<h1>书籍信息暂不可用</h1>
					<InlineError error={details.error} />
					<button
						type="button"
						className="book-details-action"
						onClick={() => void details.refetch()}
					>
						重试
					</button>
				</div>
			) : (
				book && (
					<section className="book-details" aria-label="书籍详情">
						<div className="book-details-artwork">
							<div className="book-details-cover">
								{book.cover_url && book.cover_url !== failedCover ? (
									<img
										key={`${book.cover_url}:${coverAttempt}`}
										src={`${book.cover_url}${coverAttempt ? `${book.cover_url.includes("?") ? "&" : "?"}retry=${coverAttempt}` : ""}`}
										alt={`${book.title} 封面`}
										onError={() => setFailedCover(book.cover_url)}
									/>
								) : (
									<BookCoverPlaceholder title={book.title} />
								)}
							</div>
							{book.cover_url && book.cover_url === failedCover && (
								<button
									className="book-details-action"
									type="button"
									onClick={() => {
										setFailedCover(null);
										setCoverAttempt((value) => value + 1);
									}}
								>
									重试封面
								</button>
							)}
						</div>
						<div className="book-details-content">
							<h1>{book.title}</h1>
							<p className="book-details-summary">
								EPUB · {book.chapter_count} 章
							</p>
							<div className="book-details-actions">
								<Link
									className="book-details-action primary"
									to={`/materials/${book.id}`}
									state={{
										returnTo: {
											to: `/materials/${book.id}/details`,
											label: "书籍详情",
											parent: { to: back.to, label: back.label },
										},
									}}
								>
									阅读
								</Link>
								<button
									type="button"
									className="book-details-action"
									onClick={() => setEditing(true)}
								>
									编辑书籍信息
								</button>
							</div>
						</div>
						<dl className="book-details-fields">
							<div>
								<dt>原书名</dt>
								<dd>{book.original_title || "未提供"}</dd>
							</div>
							<div>
								<dt>所属来源</dt>
								<dd>
									<Link to={`/sources/${book.source_id}`}>
										{book.source_title}
									</Link>
								</dd>
							</div>
							<div>
								<dt>导入时间</dt>
								<dd>{dateLabel(book.created_at)}</dd>
							</div>
							<div>
								<dt>阅读状态</dt>
								<dd>{statusLabels[book.status]}</dd>
							</div>
							<div>
								<dt>最近打开</dt>
								<dd>
									{book.last_opened_at
										? dateLabel(book.last_opened_at)
										: "尚未打开"}
								</dd>
							</div>
						</dl>
					</section>
				)
			)}
			{editing && <BookEditDialog id={id} close={() => setEditing(false)} />}
		</Shell>
	);
}
