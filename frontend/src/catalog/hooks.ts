import { useEffect, useRef } from "react";
import { useLocation, useSearchParams } from "react-router";
import {
	type CatalogKind,
	type CatalogState,
	catalogScrollSearch,
	readCatalogState,
	sourceListSearch,
	updateCatalogSearch,
} from "./state";
export function readPreference(key: string) {
	try {
		return localStorage.getItem(`folio-${key}`) ?? "";
	} catch {
		return "";
	}
}
export function savePreference(key: string, value: string) {
	try {
		localStorage.setItem(`folio-${key}`, value);
	} catch {
		/* Optional UI preference. */
	}
}
export function useCatalogState(kind: CatalogKind, scope: string, prefix = "") {
	const [params, setParams] = useSearchParams();
	const state = readCatalogState(
		params.toString(),
		kind,
		readPreference(`sort-${scope}`),
		prefix,
	);
	function change(patch: Partial<CatalogState>) {
		const next = { ...state, ...patch };
		if (patch.sort || patch.order)
			savePreference(
				`sort-${scope}`,
				new URLSearchParams({ sort: next.sort, order: next.order }).toString(),
			);
		setParams(updateCatalogSearch(params.toString(), patch, prefix), {
			replace: true,
		});
	}
	return { state, change };
}
export function useCatalogScroll(ready: boolean, scope = "", internal = false) {
	const location = useLocation();
	const element = useRef<HTMLDivElement>(null);
	const key =
		scope === "source-directory"
			? `folio-scroll:${scope}:${sourceListSearch(location.search, "s", "s")}`
			: `folio-scroll:${scope}:${location.pathname}?${catalogScrollSearch(location.search)}`;
	useEffect(() => {
		if (!ready) return;
		const target = internal
			? element.current
			: document.querySelector<HTMLElement>(".source-detail-content");
		let position = 0;
		try {
			position = Number(sessionStorage.getItem(key)) || 0;
		} catch {
			/* Optional restoration. */
		}
		const frame = requestAnimationFrame(() => {
			if (target) target.scrollTop = position;
			else window.scrollTo(0, position);
		});
		const save = () => {
			try {
				sessionStorage.setItem(
					key,
					String(target ? target.scrollTop : window.scrollY),
				);
			} catch {
				/* Optional restoration. */
			}
		};
		const surface = target ?? window;
		surface.addEventListener("scroll", save, { passive: true });
		return () => {
			cancelAnimationFrame(frame);
			surface.removeEventListener("scroll", save);
		};
	}, [ready, key, internal]);
	return element;
}
