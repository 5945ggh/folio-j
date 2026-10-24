import type { components } from "../src/api/schema";
import type { Segment } from "../src/content";
import type { BrowserHarness } from "./harness";

const afterLayout = () =>
	new Promise<void>((resolve) =>
		requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
	);

export async function segmentOriginStability(
	h: BrowserHarness,
	segment: Segment,
) {
	const { SegmentMaterialOrigin } = await import(
		"../src/materials/SegmentMaterialOrigin"
	);
	const { OriginalCard } = await import("../src/segments/OriginalCard");
	const { container, check, mount, mock, until } = h;
	const assert: BrowserHarness["check"] = check;
	let verifiedGeometry = "";
	const response = (
		status: components["schemas"]["SegmentProvenanceResponse"]["status"],
	) =>
		Response.json({
			segment_id: segment.id,
			status,
			assembly_rule: "concat-nfc-v1",
			title: "保留在背景的书籍标题",
			chapter_title: "独立的第二行章节标题",
			chapter_id: "chapter",
			material_provenance: segment.material_provenance ?? null,
			parts: [],
		} satisfies components["schemas"]["SegmentProvenanceResponse"]);
	for (const outcome of [
		"resolved",
		"material_deleted",
		"snapshot_mismatch",
		"error",
	] as const) {
		let reads = 0;
		let release: ((response: Response) => void) | undefined;
		mock(async (request) => {
			const path = new URL(request.url).pathname;
			assert(request.method === "GET", "Opening materials must stay read-only");
			if (path.endsWith("/translation-results")) return Response.json([]);
			if (path.endsWith("/material-provenance")) {
				reads++;
				if (reads === 1) return response("resolved");
				return new Promise<Response>((resolve) => {
					release = resolve;
				});
			}
			throw new Error(`Unexpected origin stability request ${path}`);
		});
		const dispose = await mount(
			<div className="app-shell segment-study-shell">
				<div
					data-origin-scroll
					style={{
						width: 760,
						maxWidth: "100%",
						height: 400,
						overflow: "auto",
						padding: 16,
					}}
				>
					<div style={{ height: 80 }} />
					<div data-background-origin>
						<SegmentMaterialOrigin segment={segment} />
					</div>
					<OriginalCard segment={segment} onEdit={() => {}} />
					<div style={{ height: 900 }} />
				</div>
				<div id="segment-overlays" />
			</div>,
		);
		try {
			const background = () =>
				container.querySelector<HTMLElement>(
					"[data-background-origin] .segment-material-origin",
				);
			await until(
				() => !!background()?.querySelector("a"),
				"Initial origin must resolve before opening the dialog",
			);
			const reader = container.querySelector<HTMLElement>(
				"[data-origin-scroll]",
			);
			const card = container.querySelector<HTMLElement>(
				".segment-original-card",
			);
			const trigger = container.querySelector<HTMLButtonElement>(
				"#segment-original-trigger",
			);
			assert(
				reader && card && trigger,
				"Origin stability fixture must mount real card controls",
			);
			reader.scrollTop = 40;
			// A user can only open this action once it is visible in the reader.
			trigger.scrollIntoView({ block: "nearest" });
			trigger.focus({ preventScroll: true });
			await afterLayout();
			const snapshot = () => ({
				originHeight: background()?.getBoundingClientRect().height ?? 0,
				cardTop: card.getBoundingClientRect().top,
				scrollTop: reader.scrollTop,
			});
			const before = snapshot();
			trigger.click();
			await until(
				() =>
					reads === 2 && !!release && !!container.querySelector("dialog[open]"),
				"Dialog observer must revalidate the shared origin query",
			);
			await afterLayout();
			const pending = snapshot();
			assert(
				!container.querySelector(".segment-material-origin a"),
				"Revalidation must disable cached material destinations in both observers",
			);
			assert(
				background()?.textContent?.includes("保留在背景的书籍标题") &&
					background()?.textContent?.includes("独立的第二行章节标题"),
				`Revalidation must retain both cached origin lines: ${JSON.stringify({ before, pending })}`,
			);
			assert(
				Math.abs(pending.originHeight - before.originHeight) <= 1 &&
					Math.abs(pending.cardTop - before.cardTop) <= 1 &&
					Math.abs(pending.scrollTop - before.scrollTop) <= 1,
				`Opening full materials must not shift the background: ${JSON.stringify({ before, pending })}`,
			);
			assert(
				!!document.activeElement?.closest("dialog[open]"),
				"Opening materials must move focus into the modal",
			);
			for (let frame = 0; frame < 3; frame++) {
				await afterLayout();
				const sample = snapshot();
				assert(
					Math.abs(sample.scrollTop - before.scrollTop) <= 1 &&
						Math.abs(sample.cardTop - before.cardTop) <= 1,
					`Pending origin must not oscillate the reader: ${JSON.stringify({ before, sample })}`,
				);
			}
			release?.(
				outcome === "error"
					? Response.json({ detail: "出处重新校验失败" }, { status: 500 })
					: response(outcome),
			);
			await until(
				() =>
					outcome === "resolved"
						? !!background()?.querySelector("a")
						: background()?.textContent?.includes(
								outcome === "error"
									? "重试核对出处"
									: outcome === "material_deleted"
										? "原材料已删除"
										: "快照不一致",
							) === true,
				"Origin revalidation must settle to its fresh state",
			);
			await afterLayout();
			const settled = snapshot();
			if (outcome === "resolved") {
				assert(
					Math.abs(settled.originHeight - before.originHeight) <= 1 &&
						Math.abs(settled.cardTop - before.cardTop) <= 1 &&
						Math.abs(settled.scrollTop - before.scrollTop) <= 1,
					`Successful origin revalidation must preserve background geometry: ${JSON.stringify({ before, pending, settled })}`,
				);
				verifiedGeometry = `origin ${innerWidth}px before/pending/settled: ${JSON.stringify({ before, pending, settled })}`;
			} else
				assert(
					!container.querySelector(".segment-material-origin a"),
					"Failed/deleted/mismatched refreshed origin must not expose a stale destination",
				);
			const body = container.querySelector<HTMLElement>(
				".segment-material-body",
			);
			assert(
				body?.textContent?.includes(segment.text) &&
					body.textContent.includes(segment.transcription) &&
					body.textContent.includes(segment.note),
				"Origin refresh must keep complete target, transcription and notes readable",
			);
			container
				.querySelector<HTMLButtonElement>("[aria-label='关闭原文与资料']")
				?.click();
			await until(
				() =>
					!container.querySelector("dialog[open]") &&
					document.activeElement === trigger,
				"Closing revalidated materials must restore focus to its trigger",
			);
			assert(
				reader.scrollTop >= 0 &&
					reader.scrollTop <= reader.scrollHeight - reader.clientHeight,
				"Reader scroll position must remain within its bounds",
			);
			if (outcome === "resolved")
				assert(
					Math.abs(reader.scrollTop - before.scrollTop) <= 1,
					"Closing refreshed materials must preserve the reader scroll position",
				);
		} finally {
			release?.(response("resolved"));
			dispose();
		}
	}
	let initialRelease: ((response: Response) => void) | undefined;
	let initialReads = 0;
	mock(async (request) => {
		assert(
			request.method === "GET" &&
				new URL(request.url).pathname.endsWith("/material-provenance"),
			"Initial provenance loading must only read the requested origin",
		);
		initialReads++;
		return initialReads === 1
			? new Promise<Response>((resolve) => {
					initialRelease = resolve;
				})
			: response("resolved");
	});
	const dispose = await mount(<SegmentMaterialOrigin segment={segment} />);
	try {
		await until(
			() =>
				!!initialRelease &&
				container.textContent?.includes("正在核对材料出处") === true,
			"Uncached origin must show initial loading feedback",
		);
		assert(
			!container.querySelector("a"),
			"Initial origin loading must not invent a destination",
		);
		initialRelease?.(
			Response.json({ detail: "首次读取出处失败" }, { status: 500 }),
		);
		await until(
			() => container.textContent?.includes("重试核对出处") === true,
			"Initial failed origin must offer retry",
		);
		assert(
			!container.querySelector("a"),
			"Initial failed origin must not expose a destination",
		);
		const retry = [
			...container.querySelectorAll<HTMLButtonElement>("button"),
		].find((button) => button.textContent?.trim() === "重试核对出处");
		assert(retry, "Initial failed origin retry must be reachable");
		retry.click();
		await until(
			() => initialReads === 2 && !!container.querySelector("a"),
			"Initial origin retry must recover a freshly verified destination",
		);
	} finally {
		initialRelease?.(response("resolved"));
		dispose();
	}
	return verifiedGeometry;
}
