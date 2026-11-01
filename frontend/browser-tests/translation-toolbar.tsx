import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { flushSync } from "react-dom";
import type { components } from "../src/api/schema";
import type { StudyTarget } from "../src/materials/study-api";
import type { BrowserHarness } from "./harness";
import { checkTranslationResultActions } from "./translation-result-actions";

export async function translationToolbarRegression(h: BrowserHarness) {
	const { TranslationPanel } = await import(
		"../src/translation/TranslationPanel"
	);
	const { targetIdentity } = await import("../src/translation/state");
	const { useTranslationSessions } = await import(
		"../src/translation/session-react"
	);
	const { ViewActivityProvider } = await import(
		"../src/navigation/view-activity"
	);
	const check: BrowserHarness["check"] = h.check;
	const reference: components["schemas"]["MaterialProvenance"] = {
		contract_version: "1",
		material_id: "toolbar-book",
		version_id: "version",
		ranges: [
			{
				resource_id: "r",
				spine_index: 0,
				start: 0,
				end: 3,
				exact: "猫だ。",
				text_sha256: "hash",
				prefix: "",
				suffix: "",
			},
		],
	};
	const target: StudyTarget = {
		reference,
		chapter: {
			id: "chapter",
			material_id: "toolbar-book",
			version_id: "version",
			title: "章",
			level: 0,
			resources: [
				{
					id: "r",
					text: "猫だ。",
					text_sha256: "hash",
					href: "r.xhtml",
					css: "",
					body_attributes: {},
					html_attributes: {},
				},
			],
			parts: [
				{
					resource_id: "r",
					spine_index: 0,
					start: 0,
					end: 3,
					html: "",
					leaf_start: 0,
					leaf_end: 3,
				},
			],
		},
	};
	const latest: components["schemas"]["TranslationResultResponse"] = {
		id: "toolbar-latest",
		task_id: "saved-task",
		source_id: "source",
		material_id: "toolbar-book",
		material_deleted: false,
		reader_deleted: false,
		material_provenance: reference,
		identity_sha256: await targetIdentity(reference),
		text: "猫だ。",
		translation: "已留存的当前译文。",
		context_before: "",
		context_after: "",
		target_language: "简体中文",
		scheme_name: "独立翻译",
		scheme_id: "scheme",
		scheme_revision: 1,
		model_id: "model",
		provider_name: "provider",
		protocol: "chat_completions",
		prompt_version: "translation-v2",
		run_id: "run",
		created_at: "2026-10-24T02:00:00Z",
		chapter_id: "chapter",
		parts: [],
		temperature: null,
		reasoning_effort: null,
		max_output_tokens: null,
		adopted_segment_ids: [],
	};
	const previous = {
		...latest,
		id: "toolbar-previous",
		translation: "此前的译文。",
		created_at: "2026-10-24T01:00:00Z",
	};
	const generated = {
		...latest,
		id: "toolbar-generated",
		translation: "重新生成的译文。",
		created_at: "2026-10-24T03:00:00Z",
	};
	for (const [embedded, resumed] of [
		[false, false],
		[true, false],
		[false, true],
		[true, true],
	] as const) {
		let posts = 0;
		let stops = 0;
		let closed = 0;
		let active: components["schemas"]["TranslationTaskResponse"] | null = null;
		let resultRequested = false;
		let resultResponse: Response | undefined;
		const pendingResults: Array<(response: Response) => void> = [];
		const releaseResult = (response: Response) => {
			resultResponse = response;
			for (const settle of pendingResults.splice(0)) settle(response.clone());
		};
		let restoreGate: Promise<void> | undefined;
		let restoreReads = 0;
		let changeActivity:
			| ((next: { active: boolean; activation: number }) => void)
			| undefined;
		let refreshResult: (() => Promise<void>) | undefined;
		h.mock(async (request) => {
			const path = new URL(request.url).pathname;
			if (path === "/api/settings/translation")
				return Response.json({
					id: "default",
					adapter: "llm",
					revision: 1,
					name: "独立翻译",
					model_id: "model",
					target_language: "简体中文",
					before_sentences: 0,
					after_sentences: 0,
					before_characters: 0,
					after_characters: 0,
					max_context_characters: 2000,
					max_target_characters: 2000,
				});
			if (path === "/api/materials/toolbar-book/translations") {
				if (request.method === "POST") {
					posts++;
					active = {
						id: `toolbar-task-${posts}`,
						source_id: "source",
						material_id: "toolbar-book",
						material_provenance: reference,
						text: "猫だ。",
						context_before: "",
						context_after: "",
						created_at: "2026-10-24T03:00:00Z",
						status: "queued",
						result_id: null,
						run_id: null,
						error: null,
					};
					return Response.json(active);
				}
				return Response.json({
					results: active?.result_id
						? [generated, latest, previous]
						: [latest, previous],
					tasks: active ? [active] : [],
					next_offset: null,
				});
			}
			if (path === `/api/translation-tasks/${active?.id}/stop`) {
				stops++;
				check(active, "Stop requires an accepted task");
				active = { ...active, status: "stopping" };
				return Response.json(active);
			}
			if (path === `/api/translation-tasks/${active?.id}`)
				return Response.json(active);
			if (path === `/api/translation-results/${generated.id}`) {
				if (resultResponse) return resultResponse.clone();
				return new Promise((resolve) => {
					pendingResults.push(resolve);
					resultRequested = true;
				});
			}
			const saved = [latest, previous].find(
				(item) => path === `/api/translation-results/${item.id}`,
			);
			if (saved) {
				if (saved.id === latest.id && restoreGate) {
					restoreReads++;
					await restoreGate;
				}
				return Response.json(saved);
			}
			throw new Error(`Unexpected toolbar request ${request.method} ${path}`);
		});
		function Fixture() {
			const sessions = useTranslationSessions();
			const client = useQueryClient();
			refreshResult = () =>
				client.invalidateQueries({
					queryKey: ["translation-result", generated.id],
					exact: true,
				});
			return (
				<div className="reader-r1">
					<div data-toolbar-host="initiator">
						<TranslationPanel
							materialId="toolbar-book"
							sourceId="source"
							target={target}
							embedded={embedded}
							translationSessions={sessions}
							onClose={() => {
								closed++;
							}}
							onBackToOrigin={() => {}}
						/>
					</div>
					<div data-toolbar-host="follower" hidden>
						<TranslationPanel
							materialId="toolbar-book"
							sourceId="source"
							target={target}
							embedded={!embedded}
							visible={false}
							translationSessions={sessions}
							onClose={() => {}}
							onBackToOrigin={() => {}}
						/>
					</div>
				</div>
			);
		}
		function ActivityFixture() {
			const [activity, setActivity] = useState({
				active: true,
				activation: 0,
			});
			changeActivity = setActivity;
			return (
				<ViewActivityProvider value={activity}>
					<Fixture />
				</ViewActivityProvider>
			);
		}
		const dispose = await h.mount(<ActivityFixture />);
		await h.until(
			() => !!h.container.querySelector('[data-toolbar-host="initiator"]'),
			"Toolbar fixture should mount",
		);
		const host = h.container.querySelector<HTMLElement>(
			'[data-toolbar-host="initiator"]',
		);
		check(host, "Initiating toolbar host exists");
		const action = (label: string) =>
			host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
		const output = () => host.querySelector(".translation-output")?.textContent;
		const followerOutput = () =>
			h.container.querySelector(
				'[data-toolbar-host="follower"] .translation-output',
			)?.textContent;
		const version = () =>
			host.querySelector<HTMLButtonElement>(".translation-version-action");
		const updateTask = (
			status: components["schemas"]["TranslationTaskResponse"]["status"],
			resultId: string | null = null,
		) => {
			check(active, "Task status update requires an accepted task");
			active = { ...active, status, result_id: resultId };
		};
		try {
			await h.until(
				() =>
					output() === latest.translation &&
					followerOutput() === latest.translation &&
					!!action("重新翻译") &&
					!action("重新翻译")?.disabled,
				"Toolbar should expose retranslation without opening context",
			);
			check(
				!action("重新翻译")?.closest("details"),
				"Retranslation must be outside configuration folds",
			);
			checkTranslationResultActions(h, host);
			check(
				!h.container.querySelector("details[open]"),
				"Configuration stays collapsed initially",
			);
			check(
				embedded || h.container.querySelector("h2")?.textContent === "翻译",
				"Floating card uses the compact title",
			);
			check(
				version()?.textContent === "上一版",
				"Saved history exposes a previous-version shortcut",
			);
			version()?.click();
			await h.until(
				() => output() === previous.translation,
				"Previous version should load without generation",
			);
			check(
				version()?.textContent === "返回新版",
				"Previous version offers an exact return",
			);
			version()?.click();
			await h.until(
				() => output() === latest.translation,
				"Version shortcut should return to the prior newer result",
			);
			check(posts === 0, "Version navigation must not call the model");
			if (resumed) {
				check(changeActivity, "Reader activity control must be ready");
				const setActivity = changeActivity;
				flushSync(() => setActivity({ active: false, activation: 0 }));
				let releaseRestore: (() => void) | undefined;
				restoreGate = new Promise<void>((resolve) => {
					releaseRestore = resolve;
				});
				flushSync(() => setActivity({ active: true, activation: 1 }));
				await h.until(
					() => restoreReads > 0,
					"Resume must reread the saved result before showing it",
				);
				check(
					!output() && !followerOutput(),
					"Resume must withhold cached output in both hosts before validation finishes",
				);
				check(releaseRestore, "Resume validation must be controllable");
				releaseRestore();
				restoreGate = undefined;
				await h.until(
					() =>
						output() === latest.translation &&
						followerOutput() === latest.translation &&
						!action("重新翻译")?.disabled,
					"Resume should release both hosts only after refreshing the saved output",
				);
				check(posts === 0, "Resuming must not generate a translation");
			}
			action("重新翻译")?.click();
			await h.until(
				() => !!action("停止翻译"),
				"Accepted queued task should expose the compact stop action",
			);
			check(
				output() === latest.translation,
				"Accepted queued retranslation retains the old output",
			);
			check(
				followerOutput() === latest.translation,
				"A hidden default host following the shared task must retain its old output",
			);
			check(
				!action("重新翻译") && action("停止翻译")?.textContent === "停止翻译",
				"Active translation replaces retranslation with an explicitly labelled stop action",
			);
			checkTranslationResultActions(h, host);
			check(
				h.container.querySelector(".translation-spinner"),
				"Active task shows a progress spinner",
			);
			if (!embedded) {
				action("关闭翻译（任务继续）")?.click();
				check(
					closed === 1 && stops === 0,
					"Closing the card must not stop its task",
				);
			}
			action("停止翻译")?.click();
			await h.until(
				() => !!action("停止翻译")?.disabled,
				"Stopping task disables repeated stop commands",
			);
			check(stops === 1, "Stop command targets the accepted task exactly once");
			updateTask("cancelled");
			await h.until(
				() =>
					!action("停止翻译") &&
					!!action("重新翻译") &&
					!action("重新翻译")?.disabled,
				"Cancelled retranslation should allow another explicit attempt",
			);
			check(
				output() === latest.translation,
				"Cancelling retranslation keeps the saved output readable",
			);
			action("重新翻译")?.click();
			await h.until(
				() => Number(posts) === 2 && !!action("停止翻译"),
				"Another explicit retranslation starts once",
			);
			updateTask("running");
			await h.until(
				() =>
					h.container.querySelector(".translation-progress")?.textContent ===
					"重译中",
				"Running task stays in the toolbar",
			);
			check(
				output() === latest.translation,
				"Running retranslation retains the saved output",
			);
			const more = host.querySelector<HTMLDetailsElement>(".translation-more");
			check(more, "Saved translation needs its more-actions disclosure");
			more.open = true;
			const removal = action("清除此处全部翻译");
			check(
				removal && !removal.disabled,
				"Retained output must allow deletion while the new result loads",
			);
			removal.click();
			await h.until(
				() => !!host.querySelector("dialog[open]"),
				"Deletion confirmation must open against the retained output",
			);
			const confirmation = host.querySelector("dialog[open]");
			check(
				confirmation?.querySelector("blockquote.translation-removal-target")
					?.textContent === "猫だ。" &&
					confirmation.querySelector("h2")?.textContent ===
						"清除此处全部翻译？",
				"Pending confirmation must identify the exact source and the retained version selected for removal",
			);
			updateTask("succeeded", generated.id);
			await h.until(
				() => resultRequested,
				"New result read should be independently delayed",
			);
			check(
				output() === latest.translation,
				"Completed task retains old output until the new result arrives",
			);
			check(
				version()?.disabled,
				"Version shortcut waits until the new result is readable to keep its pair consistent",
			);
			check(
				followerOutput() === latest.translation,
				"The following host also retains old output while the new result loads",
			);
			if (resumed) {
				releaseResult(
					Response.json({ detail: "new result unavailable" }, { status: 503 }),
				);
				resultRequested = false;
				await h.until(
					() =>
						[...h.container.querySelectorAll('[role="alert"]')].filter((node) =>
							node.textContent?.includes("new result unavailable"),
						).length === 2,
					"Both hosts must report the failed new-result read",
				);
				check(
					output() === latest.translation &&
						followerOutput() === latest.translation,
					"A failed new-result GET must preserve previously validated output in both resumed hosts",
				);
				check(
					version()?.disabled,
					"Failed new-result reads keep shortcut pairing disabled",
				);
				check(refreshResult, "Result refresh control must be ready");
				resultResponse = undefined;
				void refreshResult();
				await h.until(
					() => resultRequested,
					"Refreshing the failed result should issue another GET",
				);
				check(
					output() === latest.translation &&
						followerOutput() === latest.translation,
					"Retrying a new-result GET must keep the validated old output readable",
				);
			}
			releaseResult(Response.json(generated));
			await h.until(
				() =>
					output() === generated.translation &&
					followerOutput() === generated.translation,
				"New complete output replaces the retained result in both hosts",
			);
			check(
				host.querySelector("dialog[open]") === confirmation &&
					confirmation?.querySelector("blockquote.translation-removal-target")
						?.textContent === "猫だ。" &&
					confirmation.querySelector("h2")?.textContent ===
						"清除此处全部翻译？",
				"Arriving retranslation must keep the open confirmation bound to the originally selected version",
			);
			const confirm = [
				...(confirmation?.querySelectorAll<HTMLButtonElement>("button") ?? []),
			].find((button) => button.textContent === "确认删除翻译");
			check(
				confirm && !confirm.disabled,
				"Preserved version confirmation must still allow its deletion command",
			);
			const cancel = confirmation?.querySelector<HTMLButtonElement>(
				"[data-dialog-cancel]",
			);
			check(
				cancel && !cancel.disabled,
				"Preserved confirmation must remain cancellable",
			);
			const closedBeforeEscape = closed;
			const modalEscape = new KeyboardEvent("keydown", {
				key: "Escape",
				bubbles: true,
				cancelable: true,
			});
			cancel.dispatchEvent(modalEscape);
			check(
				!modalEscape.defaultPrevented &&
					closed === closedBeforeEscape &&
					host.querySelector("dialog[open]") === confirmation,
				"Modal Escape must remain available to native dialog cancellation without closing its translation host",
			);
			cancel.click();
			await h.until(
				() => !host.querySelector("dialog[open]"),
				"Cancelling preserved deletion must close it",
			);
			check(
				output() === generated.translation,
				"Cancelling deletion preserves the new complete output",
			);
			if (resumed) {
				check(
					changeActivity,
					"Reader activity control must survive retranslation",
				);
				const setActivity = changeActivity;
				flushSync(() => setActivity({ active: false, activation: 1 }));
				resultResponse = undefined;
				resultRequested = false;
				flushSync(() => setActivity({ active: true, activation: 2 }));
				await h.until(
					() => resultRequested,
					"A second resume must revalidate the current generated result",
				);
				check(
					!output() && !followerOutput(),
					"A second resume must withhold both cached generated output and earlier fallback snapshots",
				);
				releaseResult(
					Response.json(
						{ detail: "resumed result unavailable" },
						{ status: 503 },
					),
				);
				resultRequested = false;
				await h.until(
					() =>
						[...h.container.querySelectorAll('[role="alert"]')].filter((node) =>
							node.textContent?.includes("resumed result unavailable"),
						).length === 2,
					"Both hosts must report failed second-resume validation",
				);
				check(
					!output() && !followerOutput(),
					"Failed second-resume validation must not reveal output or fallback snapshots from the prior activation",
				);
				check(
					refreshResult,
					"Result refresh control must survive a second resume",
				);
				resultResponse = undefined;
				void refreshResult();
				await h.until(
					() => resultRequested,
					"Second-resume validation can retry the exact current result",
				);
				check(
					!output() && !followerOutput(),
					"Retrying resume validation must continue withholding prior-activation snapshots",
				);
				releaseResult(Response.json(generated));
				await h.until(
					() =>
						output() === generated.translation &&
						followerOutput() === generated.translation,
					"Successful second-resume validation releases the exact current result in both hosts",
				);
			}
			await h.until(
				() => version()?.textContent === "上一版",
				"Generated result should offer its preceding saved output",
			);
			version()?.click();
			await h.until(
				() => output() === latest.translation,
				"Previous shortcut reads the result from before retranslation",
			);
			check(
				Number(posts) === 2,
				"Revisiting the previous output must not generate",
			);
			const card = h.container.querySelector<HTMLElement>(".translation-card");
			check(
				card &&
					(embedded || card.getBoundingClientRect().width <= innerWidth - 24),
				"Toolbar must fit the floating card on narrow screens",
			);
		} finally {
			dispose();
		}
	}
}
