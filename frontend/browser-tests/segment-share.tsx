import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { segmentShareText } from "../src/segments/share";
import type { BrowserHarness } from "./harness";
import { materialSegment } from "./segment-materials";
import { segmentShareSourceRegression } from "./segment-share-source";

async function segmentShareComponentRegression(h: BrowserHarness) {
	await import("../src/segments/layout.css");
	const { SegmentShare } = await import("../src/segments/SegmentShare");
	const { SegmentMaterialOrigin } = await import(
		"../src/materials/SegmentMaterialOrigin"
	);
	const { until, container } = h;
	const check: BrowserHarness["check"] = h.check;
	const baseline = new URLSearchParams(location.search).has("baseline");
	const preview = new URLSearchParams(location.search).has("preview");
	const pending: { origin?: () => void; copy?: () => void } = {};
	const finishOrigin = () => pending.origin?.();
	const finishCopy = () => pending.copy?.();
	let failOrigin = false;
	let originReads = 0;
	const provenance = {
		segment_id: materialSegment.id,
		status: "resolved" as const,
		material_provenance: materialSegment.material_provenance ?? null,
		assembly_rule: "concat-nfc-v1",
		title: "回帰テストの本",
		chapter_title: "第3章",
		display: "回帰テストの本 · 第3章 · 章内约 12%",
	};
	h.mock(async () => {
		originReads++;
		await new Promise<void>((resolve) => {
			pending.origin = resolve;
			if (preview) resolve();
		});
		return failOrigin
			? Response.json({ detail: "offline" }, { status: 500 })
			: Response.json(provenance);
	});
	let setInteractive: (value: boolean) => void = () => {};
	let refreshOrigin = () => {};
	function Fixture() {
		const client = useQueryClient();
		refreshOrigin = () => {
			void client.invalidateQueries({
				queryKey: ["segments", materialSegment.id, "material-provenance"],
			});
		};
		const [interactive, update] = useState(true);
		setInteractive = update;
		return (
			<div className="app-shell segment-study-shell">
				<main style={{ gridColumn: "1 / -1", padding: 32 }}>
					<h1>片段阅读与讲解</h1>
					<p lang="ja">{materialSegment.text}</p>
					<SegmentMaterialOrigin segment={materialSegment} />
					<SegmentShare
						segment={materialSegment}
						sourceTitle="作品シリーズ"
						interactive={interactive}
					/>
				</main>
			</div>
		);
	}
	const dispose = await h.mount(<Fixture />);
	const button = (label: string) => {
		const node = container.querySelector<HTMLButtonElement>(
			`button[aria-label="${label}"]`,
		);
		check(node, `Missing ${label}`);
		return node;
	};
	await until(
		() => !!container.querySelector(".segment-share-trigger"),
		"Mount share",
	);
	const trigger = button("复制分享");
	trigger.click();
	await until(() => !!pending.origin, "Share must load provenance");
	if (preview) return "share preview: real component with local fixture";
	const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
	const writes: string[] = [];
	let rejectCopy = false;
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			writeText: async (text: string) => {
				if (rejectCopy) throw new Error("clipboard denied");
				writes.push(text);
				await new Promise<void>((resolve) => {
					pending.copy = resolve;
				});
			},
		},
	});
	try {
		if (baseline) {
			check(
				!!container.querySelector("textarea[readonly]"),
				"Existing preview is read-only",
			);
			check(
				[...container.querySelectorAll("button")].some(
					(node) => node.textContent === "仅复制原文" && !node.disabled,
				),
				"Original copy remains available during origin loading",
			);
			finishOrigin();
			return "share baseline: read-only preview and original-only loading fallback";
		}
		const dialog = container.querySelector<HTMLDialogElement>(
			".segment-share-dialog",
		);
		check(dialog, "Share dialog must exist");
		check(dialog.matches(":modal"), "Share must open a modal dialog");
		const mode = container.querySelector<HTMLSelectElement>(
			"select[aria-label='复制范围']",
		);
		const main = container.querySelector<HTMLButtonElement>(
			".segment-share-main",
		);
		const content = container.querySelector<HTMLElement>(
			".segment-share-preview",
		);
		check(mode && main && content, "Share controls must be present");
		check(
			!dialog.textContent?.includes("正在核对材料出处"),
			"Share must not show a loading explanation",
		);
		const pendingBounds = dialog.getBoundingClientRect();
		const pendingPreview = content.getBoundingClientRect();
		const actionsVisible = () => {
			for (const node of [main, mode, button("关闭复制分享")]) {
				const bounds = node.getBoundingClientRect();
				check(
					bounds.top >= 0 &&
						bounds.bottom <= innerHeight &&
						bounds.left >= 0 &&
						bounds.right <= innerWidth,
					"Share actions remain reachable in every feedback state",
				);
			}
		};
		check(main.disabled, "Full copy waits for provenance verification");
		const choose = async (value: string) => {
			mode.value = value;
			mode.dispatchEvent(new Event("change", { bubbles: true }));
			await until(
				() =>
					content.textContent ===
					expected()[value as "full" | "original" | "source"],
				"Preview follows selected mode",
			);
		};
		let verified = false;
		const expected = () =>
			segmentShareText(
				materialSegment,
				"作品シリーズ",
				verified
					? { data: provenance, isSuccess: true, isFetching: false }
					: undefined,
			);
		finishOrigin();
		verified = true;
		await until(
			() => !main.disabled && content.textContent === expected().full,
			"Origin verification completes",
		);
		const settledBounds = dialog.getBoundingClientRect();
		const settledPreview = content.getBoundingClientRect();
		check(
			originReads === 1,
			"Page and share must share one initial origin request",
		);
		check(
			Math.abs(settledBounds.height - pendingBounds.height) <= 1 &&
				Math.abs(settledBounds.top - pendingBounds.top) <= 1 &&
				Math.abs(settledPreview.height - pendingPreview.height) <= 1,
			"Origin completion must not resize or move the share dialog",
		);
		for (const value of ["full", "source", "original"]) {
			await choose(value);
			check(writes.length === 0, "Selecting a mode must not copy");
		}
		await choose("full");
		mode.focus();
		mode.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Tab",
				bubbles: true,
				cancelable: true,
			}),
		);
		check(
			document.activeElement === button("关闭复制分享"),
			"Tab wraps to the first dialog control",
		);
		button("关闭复制分享").dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Tab",
				shiftKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);
		check(
			document.activeElement === mode,
			"Shift+Tab wraps to the last dialog control",
		);
		const rect = dialog.getBoundingClientRect();
		check(
			rect.left >= 0 &&
				rect.right <= innerWidth &&
				rect.top >= 0 &&
				rect.bottom <= innerHeight,
			"Share fits viewport",
		);
		check(
			dialog.scrollWidth <= dialog.clientWidth,
			"Share has no horizontal overflow",
		);
		check(
			content.scrollHeight >= content.clientHeight,
			"Preview has bounded scrolling",
		);
		main.click();
		await until(() => writes.length === 1, "Clipboard write starts");
		check(
			writes[0] === content.textContent && main.disabled && mode.disabled,
			"Copy matches preview and prevents duplicate actions",
		);
		finishCopy();
		await until(
			() => !!container.textContent?.includes("已复制"),
			"Success feedback",
		);
		rejectCopy = true;
		main.click();
		await until(
			() => !!container.textContent?.includes("复制失败"),
			"Failure feedback",
		);
		actionsVisible();
		check(
			content.tabIndex === 0 && getComputedStyle(content).userSelect !== "none",
			"Fallback preview supports selection and keyboard focus",
		);
		mode.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Escape",
				bubbles: true,
				cancelable: true,
			}),
		);
		await until(
			() => !dialog.open && document.activeElement === trigger,
			"Close restores trigger focus",
		);
		pending.origin = undefined;
		trigger.click();
		await until(() => dialog.open, "Share reopens using page verification");
		check(mode.value === "full", "Reopen resets default mode");
		check(
			originReads === 1 &&
				!pending.origin &&
				!main.disabled &&
				content.textContent === expected().full,
			"Opening share must reuse verified origin immediately without refetching",
		);
		failOrigin = true;
		refreshOrigin();
		await until(
			() => !!pending.origin && main.disabled,
			"Explicit origin invalidation still revalidates",
		);
		check(
			!dialog.textContent?.includes("正在核对材料出处"),
			"Background verification stays quiet",
		);
		verified = false;
		await choose("original");
		check(
			!main.disabled && content.textContent === materialSegment.text,
			"Original remains copyable during background verification",
		);
		await choose("full");
		finishOrigin();
		await until(
			() => !!container.textContent?.includes("材料出处读取失败"),
			"Origin error shows saved-content fallback",
		);
		check(
			!main.disabled && !content.textContent?.includes("第3章"),
			"Failed refresh excludes cached chapter and still allows copying",
		);
		actionsVisible();
		rejectCopy = false;
		pending.copy = undefined;
		main.click();
		await until(() => !!pending.copy, "Deferred copy starts");
		setInteractive(false);
		await until(() => !dialog.open, "Hidden reading view closes share");
		finishCopy();
		setInteractive(true);
		await until(() => !trigger.disabled, "Reading view restored");
		trigger.click();
		await until(() => dialog.open, "Share reopens");
		check(
			!container.textContent?.includes("已复制"),
			"Late completion cannot leak into reopened share",
		);
		return "share: preview/mode parity, clipboard success/failure, origin fallback, viewport, focus and stale completion";
	} finally {
		if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
		else Reflect.deleteProperty(navigator, "clipboard");
		dispose();
	}
}

export async function segmentShareRegression(h: BrowserHarness) {
	const component = await segmentShareComponentRegression(h);
	const params = new URLSearchParams(location.search);
	if (params.has("preview") || params.has("baseline")) return component;
	return `${component}; ${await segmentShareSourceRegression(h)}`;
}
