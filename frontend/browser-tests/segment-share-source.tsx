import type { Segment, Source } from "../src/content";
import type { BrowserHarness } from "./harness";
import { materialSegment } from "./segment-materials";

/** Exercise the page's independent Source query, rather than supplying its title. */
export async function segmentShareSourceRegression(h: BrowserHarness) {
	const { SegmentDetail } = await import("../src/SegmentPage");
	const { container, until } = h;
	const check: BrowserHarness["check"] = h.check;
	const source: Source = {
		id: materialSegment.source_id,
		title: "遅れて届く作品",
		description: "",
		note: "不应分享的来源备注",
		created_at: materialSegment.created_at,
		updated_at: materialSegment.updated_at,
		segment_count: 1,
	};
	const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
	const writes: string[] = [];
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: async (text: string) => void writes.push(text) },
	});
	try {
		for (const scenario of [
			"success",
			"failure",
			"material",
			"dual-failure",
		] as const) {
			const failedSource =
				scenario === "failure" || scenario === "dual-failure";
			const segment: Segment = {
				...materialSegment,
				source_ref: failedSource ? "手填出处" : "",
				material_provenance:
					scenario === "material" || scenario === "dual-failure"
						? materialSegment.material_provenance
						: null,
			};
			const requests: ((response: Response) => void)[] = [];
			let originReads = 0;
			h.mock(async (request) => {
				const path = new URL(request.url).pathname;
				if (request.method !== "GET")
					throw new Error(
						`Share must stay read-only: ${request.method} ${path}`,
					);
				if (path === `/api/sources/${source.id}`)
					return new Promise<Response>((resolve) => requests.push(resolve));
				if (path === `/api/segments/${segment.id}`)
					return Response.json(segment);
				if (
					path === `/api/segments/${segment.id}/analyses` ||
					path === `/api/segments/${segment.id}/translation-results`
				)
					return Response.json([]);
				if (path === `/api/segments/${segment.id}/material-provenance`) {
					originReads++;
					if (scenario === "dual-failure")
						return Response.json({ detail: "offline" }, { status: 500 });
					return Response.json({
						segment_id: segment.id,
						status: "resolved",
						assembly_rule: "concat-nfc-v1",
						material_provenance: segment.material_provenance,
						title: "確かな材料名",
						chapter_title: "第三章",
						display: "確かな材料名 · 第三章 · 章内约 12%",
					});
				}
				throw new Error(`Unexpected share Source request: ${path}`);
			});
			const dispose = await h.mount(
				<SegmentDetail />,
				"/segments/:id",
				`/segments/${segment.id}?chat=0`,
			);
			try {
				await until(
					() =>
						!!container.querySelector(".segment-share-trigger") &&
						requests.length === 1,
					"Actual Segment page must load before its delayed Source",
				);
				container
					.querySelector<HTMLButtonElement>(".segment-share-trigger")
					?.click();
				await until(
					() => !!container.querySelector(".segment-share-dialog:modal"),
					"Actual page must open share while Source is pending",
				);
				const dialog = container.querySelector<HTMLDialogElement>(
					".segment-share-dialog",
				);
				const main = dialog?.querySelector<HTMLButtonElement>(
					".segment-share-main",
				);
				const mode = dialog?.querySelector<HTMLSelectElement>(
					"select[aria-label='复制范围']",
				);
				const preview = dialog?.querySelector<HTMLElement>(
					".segment-share-preview",
				);
				check(
					dialog && main && mode && preview,
					"Page share controls must exist",
				);
				const choose = async (value: "full" | "original" | "source") => {
					mode.value = value;
					mode.dispatchEvent(new Event("change", { bubbles: true }));
					await until(
						() =>
							mode.value === value &&
							main.textContent?.includes(
								{ full: "原文与出处", original: "原文", source: "出处" }[value],
							) === true,
						"Copy mode must update",
					);
				};
				if (scenario === "material") {
					await until(
						() =>
							!main.disabled &&
							preview.textContent?.includes("確かな材料名") === true,
						"Reliable material title must allow copying without waiting for Source",
					);
					const before = writes.length;
					main.click();
					await until(
						() => writes.length === before + 1,
						"Material share must copy with Source still pending",
					);
					check(
						writes.at(-1)?.includes("確かな材料名"),
						"Material copy must contain reliable title",
					);
					continue;
				}
				check(
					main.disabled,
					"Full share must wait for the fallback Source title on first load",
				);
				const sourceOption = mode.querySelector<HTMLOptionElement>(
					"option[value='source']",
				);
				check(
					sourceOption?.disabled,
					"Source-only copy must wait even when a handwritten source reference exists",
				);
				await choose("original");
				await until(
					() => !main.disabled,
					"Original-only copy must remain available during Source loading",
				);
				const before = writes.length;
				main.click();
				await until(
					() => writes.length === before + 1,
					"Original can copy while Source remains pending",
				);
				check(
					writes.at(-1) === segment.text,
					"Original-only copy must contain only saved target text",
				);
				await until(
					() => !mode.disabled,
					"Original copy must finish before changing mode",
				);
				await choose("full");
				if (failedSource) {
					requests[0]?.(Response.json({ detail: "offline" }, { status: 500 }));
					await until(
						() => /来源.*失败/.test(dialog.textContent ?? ""),
						"Source read failure must have explicit share feedback",
					);
					check(
						!main.disabled && preview.textContent?.includes("手填出处"),
						"Source failure must retain copyable saved content",
					);
					if (scenario === "dual-failure") {
						await until(
							() => /材料出处.*失败/.test(dialog.textContent ?? ""),
							"Both material and Source failures must be explained",
						);
						const reachable = async (node: HTMLElement, label: string) => {
							// Only scroll containers users can scroll. scrollIntoView would also
							// move overflow:hidden content and conceal clipped footer controls.
							for (
								let ancestor = node.parentElement;
								ancestor;
								ancestor = ancestor.parentElement
							) {
								if (
									/^(auto|scroll)$/.test(getComputedStyle(ancestor).overflowY)
								) {
									const target = node.getBoundingClientRect();
									const clip = ancestor.getBoundingClientRect();
									if (target.bottom > clip.bottom)
										ancestor.scrollTop += target.bottom - clip.bottom;
									else if (target.top < clip.top)
										ancestor.scrollTop += target.top - clip.top;
								}
								if (ancestor === dialog) break;
							}
							await new Promise<void>((resolve) =>
								requestAnimationFrame(() => resolve()),
							);
							const bounds = node.getBoundingClientRect();
							check(
								bounds.width > 0 &&
									bounds.height > 0 &&
									bounds.top >= 0 &&
									bounds.bottom <= innerHeight &&
									bounds.left >= 0 &&
									bounds.right <= innerWidth,
								`Dual failure ${label} must remain within the viewport after scrolling`,
							);
							for (
								let ancestor = node.parentElement;
								ancestor;
								ancestor = ancestor.parentElement
							) {
								const style = getComputedStyle(ancestor);
								if (!/^(auto|scroll|hidden|clip)$/.test(style.overflowY))
									continue;
								const clip = ancestor.getBoundingClientRect();
								check(
									bounds.top >= clip.top - 1 &&
										bounds.bottom <= clip.bottom + 1,
									`Dual failure ${label} must not be clipped by ${ancestor.className}`,
								);
								if (ancestor === dialog) break;
							}
						};
						const close = dialog.querySelector<HTMLButtonElement>(
							"button[aria-label='关闭复制分享']",
						);
						const statuses = [
							...dialog.querySelectorAll<HTMLElement>(
								".segment-share-origin-status",
							),
						];
						check(
							close && statuses.length === 2,
							"Both failures and their retry actions must be present",
						);
						for (const status of statuses)
							await reachable(status, "error feedback");
						for (const [node, label] of [
							[close, "close"],
							[main, "copy"],
							[mode, "mode"],
						] as const)
							await reachable(node, label);
						for (const retry of dialog.querySelectorAll<HTMLButtonElement>(
							".segment-share-origin-status button",
						))
							await reachable(retry, "retry");
						const materialRetry = [
							...dialog.querySelectorAll<HTMLButtonElement>(
								".segment-share-origin-status button",
							),
						].find((node) => !node.textContent?.includes("来源"));
						check(
							materialRetry,
							"Failed material provenance must offer its own retry",
						);
						materialRetry.click();
						await until(
							() => originReads === 2 && !main.disabled,
							"Material retry must finish without blocking saved-content copying",
						);
					}
					const fallback = writes.length;
					main.click();
					await until(
						() => writes.length === fallback + 1 && !mode.disabled,
						"Source failure must still allow copying the saved content",
					);
					check(
						writes.at(-1)?.includes("手填出处"),
						"Failed Source fallback must retain the handwritten source reference",
					);
					const retry = [
						...dialog.querySelectorAll<HTMLButtonElement>("button"),
					].find((node) => node.textContent?.includes("重试来源"));
					check(retry, "Source read failure must offer retry");
					retry.click();
					await until(
						() => requests.length === 2,
						"Retry must fetch Source again",
					);
					requests[1]?.(Response.json(source));
				} else requests[0]?.(Response.json(source));
				await until(
					() =>
						!main.disabled &&
						preview.textContent?.includes(source.title) === true,
					"Resolved Source must appear in full share before copying",
				);
				const complete = writes.length;
				main.click();
				await until(
					() => writes.length === complete + 1,
					"Complete Source share must copy",
				);
				check(
					writes.at(-1) === preview.textContent &&
						writes.at(-1)?.includes(source.title),
					"Clipboard must include the resolved fallback Source title",
				);
				check(
					!writes.at(-1)?.includes(source.note),
					"Source management note must remain private",
				);
				await until(() => !mode.disabled, "Full copy must finish");
				await choose("source");
				check(
					!main.disabled &&
						preview.textContent?.includes(source.title) &&
						!preview.textContent?.includes(segment.text),
					"Source-only preview must use the resolved title without original text",
				);
			} finally {
				for (const resolve of requests) resolve(Response.json(source));
				dispose();
			}
		}
		return "actual Segment page: delayed Source/original-only copy, failure/retry, complete fallback origin, independent material title and reachable dual-failure controls";
	} finally {
		if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
		else Reflect.deleteProperty(navigator, "clipboard");
	}
}
