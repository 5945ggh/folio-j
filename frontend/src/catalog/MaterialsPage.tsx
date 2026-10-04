import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { listSources, queries } from "../content";
import { InlineError, Shell } from "../Shared";
import { BookCatalog } from "./Books";
import { Tabs } from "./Controls";
import { readPreference } from "./hooks";
import { ImportDialog } from "./ImportDialog";
import { readCatalogState } from "./state";
export function MaterialsPage() {
	const [params, setParams] = useSearchParams();
	const state = readCatalogState(
		params.toString(),
		"books",
		readPreference("sort-books"),
	);
	useEffect(() => {
		if (
			params.get("type") !== "book" ||
			params.get("sort") !== state.sort ||
			params.get("order") !== state.order
		) {
			const next = new URLSearchParams(params);
			next.set("type", "book");
			next.set("sort", state.sort);
			next.set("order", state.order);
			setParams(next, { replace: true });
		}
	}, [params, setParams, state.sort, state.order]);
	const [adding, setAdding] = useState(false);
	const sources = useQuery({ queryKey: queries.sources, queryFn: listSources });
	return (
		<Shell>
			<h1 className="sr-only">素材库</h1>
			<div className="catalog-heading">
				<Tabs
					id="material-type"
					label="素材类型"
					items={[{ value: "book", label: "书籍" }]}
					value="book"
					onChange={() => {}}
				/>
				<button
					className="button primary"
					type="button"
					onClick={(event) => {
						event.currentTarget.focus();
						setAdding(true);
					}}
				>
					＋ 添加书籍
				</button>
			</div>
			{sources.isError && <InlineError error={sources.error} />}
			<section
				role="tabpanel"
				id="material-type-panel-book"
				aria-labelledby="material-type-tab-book"
			>
				<BookCatalog sources={sources.data} />
			</section>
			{adding && <ImportDialog close={() => setAdding(false)} />}
		</Shell>
	);
}
