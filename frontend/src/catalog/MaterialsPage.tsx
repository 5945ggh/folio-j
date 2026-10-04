import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { listSources, queries } from "../content";
import { InlineError, Shell } from "../Shared";
import { BookCatalog } from "./Books";
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
		<Shell className="library-a1">
			<h1 className="sr-only">素材库</h1>

			{sources.isError && <InlineError error={sources.error} />}
			<section
				role="tabpanel"
				id="material-type-panel-book"
				aria-labelledby="material-type-tab-book"
			>
				<BookCatalog sources={sources.data} add={() => setAdding(true)} />
			</section>
			{adding && <ImportDialog close={() => setAdding(false)} />}
		</Shell>
	);
}
