import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
	type Location,
	Route,
	Routes,
	useLocation,
	useNavigate,
	useNavigationType,
} from "react-router";
import type { components } from "../src/api/schema";
import type { BrowserHarness } from "./harness";
import {
	readerSessionFixture,
	readerSessionFixtureData,
} from "./reader-session-fixture";

type Schema = components["schemas"];

const {
	timestamp,
	materialId,
	versionId,
	chapterId,
	paragraphs,
	targetParagraph,
	book,
} = readerSessionFixture;
type RequestTiming = {
	method: string;
	path: string;
	start: number;
	end: number;
};
type Measurement = {
	scenario: string;
	firstFrameMs: number | null;
	allFramesMs: number | null;
	readableMs: number;
	savedMs: number;
	requests: Array<{
		method: string;
		path: string;
		startMs: number;
		fixtureResponseMs: number;
	}>;
	frameReused: boolean[];
	documentReused: boolean[];
};
const round = (value: number) => Math.round(value * 10) / 10;

/** Strict offline DOM measurements: fixture response durations are not network latency. */
export async function readerSession(
	h: BrowserHarness,
	realApp = false,
	initialTrailingSlash = false,
) {
	const params = new URLSearchParams(location.search);
	const retained = !params.has("baseline");
	const preview = params.has("preview");
	const vertical = params.get("direction") === "vertical-rl";
	const check: BrowserHarness["check"] = h.check;
	const { MaterialReader } = realApp
		? { MaterialReader: null }
		: await import("../src/materials/MaterialReader");
	// The historical measurement replaces MaterialReader in memory and has no session export.
	const production = retained || realApp ? await import("../src/App") : null;
	const segmentSelector = realApp
		? ".segment-workspace"
		: "[data-segment-page]";
	let queryClient: QueryClient | undefined;
	let navigate: ReturnType<typeof useNavigate> | undefined;
	let entry: Location | undefined;
	const entries: Array<{ location: Location; action: string }> = [];
	function Navigator() {
		queryClient = useQueryClient();
		const routeNavigate = useNavigate();
		const routeLocation = useLocation();
		const action = useNavigationType();
		useEffect(() => {
			navigate = routeNavigate;
		}, [routeNavigate]);
		useEffect(() => {
			entry = routeLocation;
			entries.push({ location: routeLocation, action });
		}, [routeLocation, action]);
		return null;
	}
	function TestRoutes() {
		if (production)
			return (
				<>
					<Navigator />
					<production.App />
				</>
			);
		check(MaterialReader, "Reader fixture component must load");
		return (
			<>
				<Navigator />
				<Routes>
					<Route path="/materials/:id" element={<MaterialReader />} />
					<Route
						path="/sources/:id"
						element={<main data-source-page="">来源占位页</main>}
					/>
					<Route
						path="/segments/:id"
						element={<main data-segment-page="">片段学习占位页</main>}
					/>
				</Routes>
			</>
		);
	}
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map(String).join(" "));
		originalWarn(...args);
	};
	localStorage.clear();
	localStorage.setItem("folio-reader-ui-v1", JSON.stringify({ focus: false }));
	localStorage.setItem(
		`folio-reader-book-ui-v1:${materialId}:${versionId}`,
		JSON.stringify({ rubyScope: "all" }),
	);
	localStorage.setItem(
		`folio-reader-book-ui-v1:other:${versionId}`,
		JSON.stringify({ rubyScope: "all" }),
	);
	const requestTimings: RequestTiming[] = [];
	let opened = 0;
	let saved = 0;
	let usageReads = 0;
	let addedStudyRecord = false;
	let materialUnavailable = false;
	let invalidProvenance = false;
	let changedVersion = false;
	let materialGate: Promise<void> | undefined;
	const savedPositions = new Map<string, Schema["ReadingPositionResponse"]>();
	h.mock(async (request) => {
		const actualPath = new URL(request.url).pathname;
		const requestedMaterialId = actualPath.match(
			/^\/api\/materials\/([^/]+)/,
		)?.[1];
		const path = actualPath.replace(
			"/api/materials/other",
			`/api/materials/${materialId}`,
		);
		check(
			request.method === "GET" ||
				(request.method === "POST" &&
					(path.endsWith("/readings/prepare") || path.endsWith("/opened"))) ||
				(request.method === "PUT" && path.endsWith("/reading-position")),
			`Unexpected reader side effect ${request.method} ${actualPath}`,
		);
		const timing: RequestTiming = {
			method: request.method,
			path: actualPath,
			start: performance.now(),
			end: 0,
		};
		requestTimings.push(timing);
		if (path === `/api/materials/${materialId}` && request.method === "GET") {
			await materialGate;
			if (materialUnavailable) {
				timing.end = performance.now();
				return Response.json({ detail: "材料不存在" }, { status: 404 });
			}
		}
		let data = readerSessionFixtureData(path, {
			realApp,
			invalidProvenance,
			addedStudyRecord,
		});
		if (path.endsWith("/opened")) opened++;
		if (path.endsWith("/usage")) usageReads++;
		if (path === `/api/materials/${materialId}` && request.method === "GET")
			data = {
				...book,
				reading_position:
					savedPositions.get(requestedMaterialId ?? materialId) ??
					(book.reading_position
						? {
								...book.reading_position,
								settings: {
									font_size: 22,
									line_height: 2,
									writing_mode: vertical ? "vertical-rl" : "horizontal-tb",
								},
							}
						: null),
			} satisfies Schema["MaterialResponse"];
		else if (path.endsWith("/search"))
			data = {
				material_id: materialId,
				version_id: versionId,
				query: new URL(request.url).searchParams.get("q") ?? "",
				items: [],
				total: 0,
				offset: 0,
				limit: 50,
			} satisfies Schema["MaterialSearchResponse"];
		else if (path.endsWith("/reading-position") && request.method === "PUT") {
			const update: Schema["ReadingPositionUpdate"] = await request.json();
			saved++;
			data = {
				...update,
				revision: update.expected_revision + 1,
				progress: 0,
				updated_at: timestamp,
			} satisfies Schema["ReadingPositionResponse"];
			savedPositions.set(
				requestedMaterialId ?? materialId,
				data as Schema["ReadingPositionResponse"],
			);
		} else if (data === undefined)
			throw new Error(
				`Unmocked reader session request ${request.method} ${path}`,
			);
		if (requestedMaterialId === "other" && data && typeof data === "object") {
			if ("material_id" in data) data = { ...data, material_id: "other" };
			else if ("id" in data && path === `/api/materials/${materialId}`)
				data = { ...data, id: "other" };
		}
		if (
			changedVersion &&
			data &&
			typeof data === "object" &&
			"version_id" in data
		) {
			data = {
				...data,
				version_id: "v2",
				...("reading_position" in data && data.reading_position
					? { reading_position: { ...data.reading_position, version_id: "v2" } }
					: {}),
			};
		}
		const response = Response.json(data);
		timing.end = performance.now();
		return response;
	});
	const frames = () => [
		...h.container.querySelectorAll<HTMLIFrameElement>("iframe.material-part"),
	];
	let started = performance.now();
	let firstFrame: number | null = null;
	let allFrames: number | null = null;
	let observing = true;
	const sample = () => {
		if (!observing) return;
		const current = frames();
		if (
			firstFrame === null &&
			current.length &&
			current[0]?.getClientRects().length
		)
			firstFrame = performance.now() - started;
		if (
			allFrames === null &&
			current.length === 3 &&
			current[0]?.getClientRects().length &&
			current.every(
				(frame) =>
					(frame.contentDocument?.querySelectorAll("ruby[data-auto-ruby]")
						.length ?? 0) >= 120,
			)
		)
			allFrames = performance.now() - started;
		requestAnimationFrame(sample);
	};
	requestAnimationFrame(sample);
	const measurements: Measurement[] = [];
	const measure = async (
		scenario: string,
		previous: HTMLIFrameElement[] = [],
		documents: (Document | null)[] = [],
		requestIndex = 0,
		openedBefore = 0,
		savedBefore = 0,
		usageBefore = 0,
	) => {
		await h.until(
			() =>
				allFrames !== null &&
				(retained && previous.length
					? usageReads > usageBefore
					: opened > openedBefore),
			`${scenario}: all frames must have ruby and finish presentation`,
		);
		const readable = performance.now() - started;
		await h.until(
			() => saved > savedBefore,
			`${scenario}: current reading position must be saved`,
		);
		measurements.push({
			scenario,
			firstFrameMs: firstFrame === null ? null : round(firstFrame),
			allFramesMs: allFrames === null ? null : round(allFrames),
			readableMs: round(readable),
			savedMs: round(performance.now() - started),
			requests: requestTimings.slice(requestIndex).map((timing) => ({
				method: timing.method,
				path: timing.path,
				startMs: round(timing.start - started),
				fixtureResponseMs: round(timing.end - timing.start),
			})),
			frameReused: frames().map((frame, index) => frame === previous[index]),
			documentReused: frames().map(
				(frame, index) => frame.contentDocument === documents[index],
			),
		});
	};
	const dispose = await h.mount(
		<TestRoutes />,
		retained ? "/" : "*",
		`/materials/${materialId}${initialTrailingSlash ? "/" : ""}`,
		production?.appRoutes.map((route) => {
			if (route.path === "/sources/:id")
				return {
					...route,
					element: <main data-source-page="">来源占位页</main>,
				};
			if (!realApp && route.path === "/segments/:id")
				return {
					...route,
					element: <main data-segment-page="">片段学习占位页</main>,
				};
			return route;
		}),
	);
	try {
		await measure("cold open");
		const previous = frames();
		const documents = previous.map((frame) => frame.contentDocument);
		check(navigate, "Test route navigator must be ready");
		const go = navigate;
		if (initialTrailingSlash) {
			check(
				entry?.pathname === `/materials/${materialId}/` &&
					previous.length === 3,
				"The actual App trailing-slash reader URL must load all reading frames",
			);
			for (const suffix of ["", "/"]) {
				go(`/materials/${materialId}${suffix}`);
				await h.until(
					() => entry?.pathname === `/materials/${materialId}${suffix}`,
					"Switching reader URL trailing slash must finish navigation",
				);
				check(
					frames().length === 3 &&
						frames().every(
							(frame, index) =>
								frame === previous[index] &&
								frame.contentDocument === documents[index] &&
								!!frame.getClientRects().length,
						),
					"Trailing-slash URL changes must preserve visible iframe and Document identities",
				);
			}
		}
		go("/segments/saved");
		await h.until(
			() => !!h.container.querySelector(segmentSelector),
			"Segment route must mount",
		);
		if (retained) {
			check(
				previous.every(
					(frame, index) =>
						frame.isConnected && frame.contentDocument === documents[index],
				),
				"Paused reader must preserve every iframe and Document",
			);
			check(
				previous.every((frame) => frame.getClientRects().length === 0),
				"Paused reader must not remain visible on the Segment page",
			);
			const pausedViewport =
				h.container.querySelector<HTMLElement>(".reader-viewport");
			check(pausedViewport, "Paused viewport must remain mounted");
			const pausedScroll = [
				pausedViewport.scrollTop,
				pausedViewport.scrollLeft,
			];
			document.body.dispatchEvent(
				new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }),
			);
			document.body.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
			);
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			);
			check(
				pausedViewport.scrollTop === pausedScroll[0] &&
					pausedViewport.scrollLeft === pausedScroll[1],
				"Background reader must ignore global keyboard navigation",
			);
			addedStudyRecord = true;
		}
		const requestIndex = requestTimings.length;
		const usageBefore = usageReads;
		const openedBefore = opened;
		const savedBefore = saved;
		started = performance.now();
		firstFrame = null;
		allFrames = null;
		go(`/materials/${materialId}?segment=saved`);
		await measure(
			"reader → segment → ?segment return",
			previous,
			documents,
			requestIndex,
			openedBefore,
			savedBefore,
			usageBefore,
		);
		if (retained) {
			check(
				frames().every(
					(frame, index) =>
						frame === previous[index] &&
						frame.contentDocument === documents[index],
				),
				`Returning to the same material must reuse all iframe and Document identities: ${JSON.stringify(measurements)}`,
			);
			const returnRequests = requestTimings.slice(requestIndex);
			check(
				!returnRequests.some(
					(item) =>
						item.path.endsWith("/readings") ||
						item.path === `/api/materials/${materialId}/chapters/${chapterId}`,
				),
				"Resuming must not reload chapter/readings payloads",
			);
			await h.until(() => {
				if (innerWidth <= 720 && !vertical) {
					const highlights =
						frames()[0]?.contentDocument?.defaultView?.CSS.highlights.get(
							"folio-study",
						);
					return !!highlights && highlights.size >= 1;
				}
				return (
					h.container.querySelectorAll(".reader-study-margin").length === 2
				);
			}, "Returning must refresh chapter study records created on the Segment page");
			check(
				returnRequests.some((item) => item.path.endsWith("/segments")) &&
					returnRequests.some((item) =>
						item.path.endsWith(`/chapters/${chapterId}/translations`),
					),
				"Returning must refresh both chapter segments and translations",
			);
		}
		const targetFrame = frames()[2];
		const targetDoc = targetFrame?.contentDocument;
		const targetLeaf = targetDoc?.querySelector(
			`[data-locator-leaf="${targetParagraph}"]`,
		);
		const viewport = h.container.querySelector<HTMLElement>(".reader-viewport");
		check(
			targetFrame && targetDoc && targetLeaf && viewport,
			"Original location must remain projectable in the third frame",
		);
		const projection = (await import("../src/materials/dom")).projectPart(
			targetDoc,
			paragraphs.slice(280).join(""),
			280,
		);
		check(
			projection.raw === paragraphs.slice(280).join(""),
			"Ruby must preserve canonical source text in the located frame",
		);
		const targetCoordinate = vertical
			? targetFrame.getBoundingClientRect().left +
				targetLeaf.getBoundingClientRect().left
			: targetFrame.getBoundingClientRect().top +
				targetLeaf.getBoundingClientRect().top;
		const viewStart = vertical
			? viewport.getBoundingClientRect().left
			: viewport.getBoundingClientRect().top;
		const viewEnd = vertical
			? viewport.getBoundingClientRect().right
			: viewport.getBoundingClientRect().bottom;
		check(
			targetCoordinate >= viewStart - 2 && targetCoordinate < viewEnd,
			`?segment must show exact original paragraph 350, coordinate=${targetCoordinate}, viewport=${viewStart}..${viewEnd}`,
		);
		if (retained && !preview) {
			// Let the existing 550ms position debounce drain before measuring paint-only changes.
			const settlingStarted = performance.now();
			await h.until(() => {
				const writes = requestTimings.filter(
					(request) =>
						request.method === "PUT" &&
						request.path.endsWith("/reading-position"),
				);
				const last = writes.at(-1);
				return (
					!!last?.end &&
					performance.now() - Math.max(settlingStarted, last.end) >= 700
				);
			}, "Reading position writes must settle before changing the paper theme");
			const reader = h.container.querySelector<HTMLElement>("main.reader-r1");
			const originalTheme = reader?.dataset.theme;
			check(
				reader && (originalTheme === "white" || originalTheme === "black"),
				"Reader paper theme must resolve independently",
			);
			const originalPreference = localStorage.getItem("folio-reader-ui-v1");
			const frameSnapshot = frames().map((frame) => {
				const doc = frame.contentDocument;
				const presentation = doc?.getElementById("folio-reader-presentation");
				check(
					doc && presentation,
					"Each long chapter frame must have ruby presentation",
				);
				return {
					frame,
					doc,
					presentation,
					leaves: [...doc.querySelectorAll("[data-locator-leaf]")],
					ruby: [...doc.querySelectorAll("ruby, rt")],
					css: presentation.textContent,
				};
			});
			const walker = targetDoc.createTreeWalker(
				targetLeaf,
				NodeFilter.SHOW_TEXT,
			);
			let selectedText = walker.nextNode();
			while (
				selectedText &&
				(!selectedText.textContent?.length ||
					selectedText.parentElement?.closest("rt"))
			)
				selectedText = walker.nextNode();
			check(
				selectedText?.textContent?.length,
				"Located source must have selectable text",
			);
			const range = targetDoc.createRange();
			range.setStart(selectedText, 0);
			range.setEnd(selectedText, 1);
			const selection = targetDoc.getSelection();
			check(selection, "Native frame selection must be available");
			selection.removeAllRanges();
			selection.addRange(range);
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			);
			const scroll = vertical ? viewport.scrollLeft : viewport.scrollTop;
			check(
				Math.abs(scroll) > 0,
				"Paper theme regression must run at a nonzero long-chapter scroll offset",
			);
			const screenCoordinate = () =>
				vertical
					? targetFrame.getBoundingClientRect().left +
						targetLeaf.getBoundingClientRect().left
					: targetFrame.getBoundingClientRect().top +
						targetLeaf.getBoundingClientRect().top;
			const coordinate = screenCoordinate();
			const savedBeforeTheme = saved;
			const presentationMutations: MutationRecord[] = [];
			const observer = new MutationObserver((records) =>
				presentationMutations.push(...records),
			);
			for (const { presentation } of frameSnapshot)
				observer.observe(presentation, {
					childList: true,
					characterData: true,
					subtree: true,
					attributes: true,
				});
			const switchPreference = (value: string | null) => {
				const oldValue = localStorage.getItem("folio-reader-ui-v1");
				if (value === null) localStorage.removeItem("folio-reader-ui-v1");
				else localStorage.setItem("folio-reader-ui-v1", value);
				window.dispatchEvent(
					new StorageEvent("storage", {
						key: "folio-reader-ui-v1",
						oldValue,
						newValue: value,
						storageArea: localStorage,
						url: location.href,
					}),
				);
			};
			try {
				const alternateTheme = originalTheme === "white" ? "black" : "white";
				for (const theme of [alternateTheme, originalTheme]) {
					const startedTheme = performance.now();
					switchPreference(
						theme === originalTheme
							? originalPreference
							: JSON.stringify({
									...JSON.parse(originalPreference ?? "{}"),
									theme,
								}),
					);
					await h.until(
						() => reader.dataset.theme === theme,
						"Reader must apply cross-tab paper preference changes",
					);
					await h.until(
						() => performance.now() - startedTheme >= 700,
						"Paper repaint must leave the delayed position queue idle",
					);
					check(
						frameSnapshot.every(
							({ frame, doc, presentation, leaves, ruby, css }, index) =>
								frames()[index] === frame &&
								frame.contentDocument === doc &&
								doc.getElementById("folio-reader-presentation") ===
									presentation &&
								presentation.textContent === css &&
								leaves.every(
									(leaf, leafIndex) =>
										doc.querySelectorAll("[data-locator-leaf]")[leafIndex] ===
										leaf,
								) &&
								ruby.every(
									(node, rubyIndex) =>
										doc.querySelectorAll("ruby, rt")[rubyIndex] === node,
								),
						),
						"Paper repaint must preserve frame, original leaf, ruby and presentation identities",
					);
					check(
						selection.rangeCount === 1 &&
							!selection.isCollapsed &&
							selection.anchorNode === selectedText &&
							selection.anchorOffset === 0 &&
							selection.focusNode === selectedText &&
							selection.focusOffset === 1,
						"Paper repaint must preserve the exact native source selection",
					);
					check(
						Math.abs(
							(vertical ? viewport.scrollLeft : viewport.scrollTop) - scroll,
						) < 1 && Math.abs(screenCoordinate() - coordinate) < 1,
						"Paper repaint must preserve the nonzero scroll and original source screen position",
					);
					const background = targetDoc.defaultView?.getComputedStyle(
						targetDoc.body,
					).backgroundColor;
					check(
						background ===
							(theme === "black" ? "rgb(25, 25, 25)" : "rgb(255, 255, 255)"),
						"Real iframe paper paint must follow Reader theme",
					);
					check(
						presentationMutations.length === 0,
						"Paper repaint must not rewrite or rebind ruby presentation",
					);
					check(
						saved === savedBeforeTheme,
						"Paper repaint must not enqueue extra reading-position PUTs",
					);
				}
			} finally {
				observer.disconnect();
				switchPreference(originalPreference);
				selection.removeAllRanges();
			}
		}
		if (retained && !preview) {
			const plainReturnUsage = usageReads;
			const searchDraft = "尾斜杠片段往返保留的搜索草稿";
			if (realApp) {
				const toc = h.container.querySelector<HTMLButtonElement>(
					'button[aria-label="目录"]',
				);
				check(toc, "Actual reader must expose the navigation panel");
				toc.click();
				await h.until(
					() => !!h.container.querySelector('button[data-tab="search"]'),
					"Actual reader navigation tabs must mount",
				);
				h.container
					.querySelector<HTMLButtonElement>('button[data-tab="search"]')
					?.click();
				const search = h.container.querySelector<HTMLInputElement>(
					'input[placeholder="搜索本书原文…"]',
				);
				check(search, "Actual reader must expose its search draft input");
				h.inputValue(search, searchDraft);
				await h.until(
					() => search.value === searchDraft,
					"Reader search must accept the unsaved draft",
				);
			}
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			);
			const scrollBeforePlainReturn = vertical
				? viewport.scrollLeft
				: viewport.scrollTop;
			go(realApp ? "/segments/saved/" : "/segments/saved");
			await h.until(
				() => !!h.container.querySelector(segmentSelector),
				"Plain return scenario must pause the reader",
			);
			if (realApp) {
				check(
					entry?.pathname === "/segments/saved/" &&
						previous.every(
							(frame, index) =>
								frame.isConnected &&
								frame.contentDocument === documents[index] &&
								frame.getClientRects().length === 0,
						),
					"Trailing-slash Segment route must pause the same iframe and Document identities",
				);
			}
			go(`/materials/${materialId}`);
			await h.until(
				() =>
					usageReads > plainReturnUsage &&
					frames().length === 3 &&
					frames().every((frame) => !!frame.getClientRects().length),
				"Returning without a target must resume the same session",
			);
			check(
				frames().every(
					(frame, index) =>
						frame === previous[index] &&
						frame.contentDocument === documents[index],
				),
				"Plain return must reuse the same frames and documents",
			);
			await h.until(
				() =>
					Math.abs(
						(vertical ? viewport.scrollLeft : viewport.scrollTop) -
							scrollBeforePlainReturn,
					) < 2,
				"Returning without ?segment must preserve the prior reading position",
			);
			if (realApp) {
				const search = h.container.querySelector<HTMLInputElement>(
					'input[placeholder="搜索本书原文…"]',
				);
				check(
					search?.value === searchDraft,
					"Returning from a trailing-slash Segment route must preserve the reader search draft",
				);
				const beforeForwardUsage = usageReads;
				go(-1);
				await h.until(
					() => !!h.container.querySelector(segmentSelector),
					"History back must reopen the actual Segment route",
				);
				check(
					previous.every(
						(frame, index) =>
							frame.isConnected &&
							frame.contentDocument === documents[index] &&
							frame.getClientRects().length === 0,
					),
					"History back must pause the same reader documents",
				);
				go(1);
				await h.until(
					() =>
						usageReads > beforeForwardUsage &&
						frames().length === 3 &&
						frames().every(
							(frame, index) =>
								frame === previous[index] &&
								frame.contentDocument === documents[index] &&
								!!frame.getClientRects().length,
						) &&
						Math.abs(
							(vertical ? viewport.scrollLeft : viewport.scrollTop) -
								scrollBeforePlainReturn,
						) < 2,
					"History forward must resume the same documents and reading position",
				);
			}
		}
		if (retained && !preview && !realApp) {
			// POP uses the same production DataRouter as PUSH; both directions retain the surface.
			go("/segments/saved");
			await h.until(
				() => entry?.pathname === "/segments/saved",
				"History scenario must enter Segment",
			);
			go(-1);
			await h.until(
				() =>
					entry?.pathname === `/materials/${materialId}` &&
					frames().length === 3 &&
					frames().every((frame) => !!frame.getClientRects().length),
				"History back must resume the reader",
			);
			go(1);
			await h.until(
				() =>
					entry?.pathname === "/segments/saved" &&
					previous.every((frame) => frame.getClientRects().length === 0),
				"History forward must pause the same reader",
			);
			go(-1);
			await h.until(
				() =>
					entry?.pathname === `/materials/${materialId}` &&
					previous.every((frame) => !!frame.getClientRects().length),
				"A second history back must resume the retained surface",
			);
			check(
				frames().every(
					(frame, index) =>
						frame === previous[index] &&
						frame.contentDocument === documents[index],
				),
				"History back/forward must preserve all iframe and Document identities",
			);
			const queryRequestIndex = requestTimings.length;
			const queryReturn = "/sources/source?from=same-book";
			go(`/materials/${materialId}?segment=saved&entry=same-book`, {
				state: { returnTo: { to: queryReturn, label: "来源" } },
			});
			await h.until(
				() =>
					entry?.search === "?segment=saved&entry=same-book" &&
					requestTimings
						.slice(queryRequestIndex)
						.some((item) => item.path.endsWith("/material-provenance")) &&
					previous.every((frame) => !!frame.getClientRects().length),
				"Active same-book query entry must validate its new Segment target",
			);
			const queryBack = h.container.querySelector<HTMLAnchorElement>(
				'.reader-r1 a[aria-label="返回来源"]',
			);
			check(
				queryBack?.getAttribute("href") === queryReturn,
				"Active same-book entry must update its return state",
			);
			check(
				frames().every(
					(frame, index) =>
						frame === previous[index] &&
						frame.contentDocument === documents[index],
				),
				"Active same-book query changes must reuse the existing reading surface",
			);
			const stateRequestIndex = requestTimings.length;
			const stateReturn = "/sources/source?from=state-only";
			go(`/materials/${materialId}?segment=saved&entry=same-book`, {
				replace: true,
				state: { returnTo: { to: stateReturn, label: "更新来源" } },
			});
			await h.until(
				() =>
					h.container
						.querySelector<HTMLAnchorElement>(
							'.reader-r1 a[aria-label="返回更新来源"]',
						)
						?.getAttribute("href") === stateReturn,
				"State-only replace must update the reader return label and destination",
			);
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			);
			check(
				frames().every(
					(frame, index) =>
						frame === previous[index] &&
						frame.contentDocument === documents[index] &&
						!!frame.getClientRects().length,
				),
				"State-only replace must preserve visible iframe and Document identities",
			);
			check(
				!requestTimings
					.slice(stateRequestIndex)
					.some(
						(item) =>
							item.path === `/api/materials/${materialId}` ||
							item.path.endsWith("/readings/prepare"),
					),
				"State-only replace must not reopen or revalidate the reading session",
			);
			go("/sources/source");
			await h.until(
				() => !!h.container.querySelector("[data-source-page]"),
				"Non-retained source route must mount",
			);
			await h.until(
				() => previous.every((frame) => !frame.isConnected),
				"Leaving the retained route family must evict the reader",
			);
			const evictionRequestIndex = requestTimings.length;
			go(`/materials/${materialId}`);
			await h.until(
				() =>
					frames().length === 3 &&
					frames().every(
						(frame, index) =>
							frame.contentDocument?.querySelector("ruby[data-auto-ruby]") &&
							frame !== previous[index],
					),
				"Returning after eviction must build fresh frames",
			);
			check(
				requestTimings
					.slice(evictionRequestIndex)
					.some((item) => item.path.endsWith("/readings/prepare")),
				"Evicted reader must use the normal opening preparation",
			);

			const beforeOtherMaterial = frames();
			go("/materials/other");
			await h.until(
				() =>
					frames().length === 3 &&
					frames().every(
						(frame, index) =>
							frame !== beforeOtherMaterial[index] &&
							!!frame.contentDocument?.querySelector("ruby[data-auto-ruby]"),
					),
				"A different material must replace the sole retained reading session",
			);
			check(
				beforeOtherMaterial.every((frame) => !frame.isConnected),
				"Opening a different material must dispose the previous session",
			);
			const beforeExpiry = frames();
			let expire: (() => void) | undefined;
			const setTimeoutOriginal = window.setTimeout;
			const dateNowOriginal = Date.now;
			window.setTimeout = ((
				callback: TimerHandler,
				delay?: number,
				...args: unknown[]
			) => {
				if (
					delay !== undefined &&
					delay >= 10 * 60 * 1000 - 1000 &&
					delay <= 10 * 60 * 1000 &&
					typeof callback === "function"
				)
					expire = () => callback(...args);
				return setTimeoutOriginal(callback, delay, ...args);
			}) as typeof window.setTimeout;
			try {
				go("/segments/saved");
				await h.until(
					() => !!h.container.querySelector(segmentSelector) && !!expire,
					"Pausing must schedule a bounded ten-minute expiry",
				);
				check(expire, "Retained reader must have an expiry callback");
				const future = Date.now() + 10 * 60 * 1000 + 1;
				Date.now = () => future;
				expire();
				await h.until(
					() => beforeExpiry.every((frame) => !frame.isConnected),
					"Expiry must dispose all paused iframe documents",
				);
			} finally {
				window.setTimeout = setTimeoutOriginal;
				Date.now = dateNowOriginal;
			}

			const openFresh = async () => {
				go("/sources/source");
				await h.until(
					() => !!h.container.querySelector("[data-source-page]"),
					"Reset route must dispose a failed session",
				);
				go(`/materials/${materialId}`);
				await h.until(
					() =>
						frames().length === 3 &&
						frames().every(
							(frame) =>
								!!frame.getClientRects().length &&
								!!frame.contentDocument?.querySelector("[data-locator-leaf]"),
						),
					"Fresh reader must present before validation regression",
				);
			};
			for (const failure of [
				"material missing",
				"invalid provenance",
			] as const) {
				await openFresh();
				const staleFrames = frames();
				go("/segments/saved");
				await h.until(
					() => !!h.container.querySelector(segmentSelector),
					"Failure scenario must pause on Segment route",
				);
				materialUnavailable = failure === "material missing";
				invalidProvenance = failure === "invalid provenance";
				let releaseMaterial: (() => void) | undefined;
				materialGate = new Promise<void>((resolve) => {
					releaseMaterial = resolve;
				});
				const beforeValidation = requestTimings.length;
				go(`/materials/${materialId}?segment=saved`);
				await h.until(
					() =>
						requestTimings
							.slice(beforeValidation)
							.some((item) => item.path === `/api/materials/${materialId}`),
					"Return must validate material before showing saved content",
				);
				check(
					staleFrames.every((frame) => frame.getClientRects().length === 0),
					"Return must conceal the old surface while validation is pending",
				);
				check(
					releaseMaterial,
					"Validation response must be controlled by this test",
				);
				releaseMaterial();
				materialGate = undefined;
				await h.until(
					() => !!h.container.querySelector(".reader-opening [role=alert]"),
					"Failed material/provenance validation must show the opening error",
				);
				check(
					frames().every((frame) => frame.getClientRects().length === 0),
					"Failed validation must not reveal stale reading content",
				);
				materialUnavailable = false;
				invalidProvenance = false;
			}
			await openFresh();
			const oldVersionFrames = frames();
			go("/segments/saved");
			await h.until(
				() => !!h.container.querySelector(segmentSelector),
				"Version regression must pause reader",
			);
			changedVersion = true;
			localStorage.setItem(
				`folio-reader-book-ui-v1:${materialId}:v2`,
				JSON.stringify({ rubyScope: "all" }),
			);
			go(`/materials/${materialId}`);
			await h.until(
				() =>
					frames().length === 3 &&
					frames().every(
						(frame, index) =>
							frame !== oldVersionFrames[index] &&
							!!frame.getClientRects().length &&
							!!frame.contentDocument?.querySelector("ruby[data-auto-ruby]"),
					),
				"A changed material version must reopen with fresh iframe documents",
			);
			go("/sources/source");
			await h.until(
				() => !!h.container.querySelector("[data-source-page]"),
				"Import entry scenario must start after disposing the previous session",
			);
			const importEntryIndex = entries.length;
			const importReturn = "/sources/source?from=import";
			go(`/materials/${materialId}?entry=import`, {
				state: {
					materialImported: true,
					materialReused: false,
					returnTo: { to: importReturn, label: "导入来源" },
				},
			});
			await h.until(
				() =>
					entry?.search === "?entry=import" &&
					entry.state &&
					!("materialImported" in entry.state) &&
					!("materialReused" in entry.state) &&
					frames().length === 3 &&
					frames().every((frame) => !!frame.getClientRects().length),
				"Import entry must consume transient state and present normally",
			);
			const stableEntryCount = entries.length;
			await new Promise((resolve) => setTimeout(resolve, 100));
			check(
				entries.length === stableEntryCount &&
					entries
						.slice(importEntryIndex)
						.filter((item) => item.action === "REPLACE").length === 1,
				"Import state must be replaced exactly once without a navigation loop",
			);
			const openBookInfo = async () => {
				const info = h.container.querySelector<HTMLButtonElement>(
					'button[aria-label="书籍信息"]',
				);
				check(info, "Reader must expose book information");
				info.click();
				await h.until(
					() => !!h.container.querySelector(".reader-book-info"),
					"Book information panel must open",
				);
			};
			await openBookInfo();
			check(
				h.container.textContent?.includes("已新导入书籍。"),
				"Import notice must survive its transient route-state replacement",
			);
			const importBack = h.container.querySelector<HTMLAnchorElement>(
				'.reader-r1 a[aria-label="返回导入来源"]',
			);
			check(
				importBack?.getAttribute("href") === importReturn,
				"Import-state replace must preserve its explicit return destination",
			);
			importBack.click();
			await h.until(
				() =>
					entry?.pathname === "/sources/source" &&
					entry.search === "?from=import" &&
					!!h.container.querySelector("[data-source-page]"),
				"Consumed import entry must return to the requested source query",
			);
			go(-1);
			await h.until(
				() =>
					entry?.pathname === `/materials/${materialId}` &&
					entry.search === "?entry=import" &&
					frames().length === 3 &&
					frames().every((frame) => !!frame.getClientRects().length),
				"History back after import return must reopen the consumed entry",
			);
			await openBookInfo();
			check(
				!h.container.textContent?.includes("已新导入书籍。"),
				"History must not replay a consumed import notice",
			);
			const { waitForPositionWrites } = await import(
				"../src/materials/persistence"
			);
			check(queryClient, "Session fixture must share the real query cache");
			for (const externalRevision of [false, true]) {
				const cachedFrames = frames();
				const cachedDocuments = cachedFrames.map(
					(frame) => frame.contentDocument,
				);
				go("/segments/saved");
				await h.until(
					() => !!h.container.querySelector(segmentSelector),
					"Cache collection regression must pause the real reader",
				);
				await waitForPositionWrites(materialId);
				const drained = savedPositions.get(materialId);
				check(
					drained && drained.revision > 0,
					"A local writer must have advanced and drained its CAS revision",
				);
				queryClient.removeQueries({
					queryKey: ["materials", materialId],
					exact: true,
				});
				check(
					queryClient.getQueryData(["materials", materialId]) === undefined,
					"Inactive book query must actually be removed before reactivation",
				);
				if (externalRevision)
					savedPositions.set(materialId, {
						...drained,
						revision: drained.revision + 1,
					});
				const beforeResumeUsage = usageReads;
				go(`/materials/${materialId}`);
				await h.until(
					() =>
						usageReads > beforeResumeUsage &&
						frames().length === 3 &&
						frames().every((frame) => !!frame.getClientRects().length),
					"Reactivation must validate the server revision after cache collection",
				);
				check(
					frames().every((frame, index) =>
						externalRevision
							? frame !== cachedFrames[index] &&
								frame.contentDocument !== cachedDocuments[index]
							: frame === cachedFrames[index] &&
								frame.contentDocument === cachedDocuments[index],
					),
					externalRevision
						? "External CAS revision must replace the old reader documents"
						: "Drained local writer revision must preserve iframe and Document identities without book cache",
				);
			}
		}
		check(
			!retained || warnings.length === 0,
			`Shared reader session routes must not emit warnings: ${warnings.join("\n")}`,
		);
		return `reader session (${retained ? "retained" : "baseline"}; 400 paragraphs, 3 iframes, 400 ruby tokens; offline fixture responses, real DOM clock; viewport ${innerWidth}x${innerHeight})\n${JSON.stringify(measurements, null, 2)}\n?segment exact paragraph 350 visible; canonical projection preserved${retained && !preview ? "; paper repaint preserves scrolled source, native selection, ruby bindings and idle position queue" : ""}`;
	} finally {
		console.warn = originalWarn;
		observing = false;
		if (!preview) dispose();
	}
}
