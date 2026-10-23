import { type ReactNode, useEffect, useRef } from "react";
import type { Settings } from "./api";
import { restoreReaderPanelFocus } from "./motion";
import type { BookUiPreferences, ReaderUiPreferences } from "./preferences";

export function ReaderPanel({
	title,
	side = "right",
	onClose,
	inactive = false,
	closing = false,
	children,
}: {
	title: string;
	side?: "right" | "left";
	onClose: () => void;
	inactive?: boolean;
	closing?: boolean;
	children: ReactNode;
}) {
	const root = useRef<HTMLElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	useEffect(() => {
		if (closing) return;
		const previous = document.activeElement;
		const node = root.current;
		const keydown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.isComposing || event.defaultPrevented)
				return;
			event.preventDefault();
			event.stopPropagation();
			closeRef.current();
		};
		node?.addEventListener("keydown", keydown);
		node?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
		return () => {
			node?.removeEventListener("keydown", keydown);
			if (node) restoreReaderPanelFocus(node, previous);
		};
	}, [closing]);
	return (
		<section
			ref={root}
			className={`reader-local-panel reader-local-panel-${side}`}
			role="dialog"
			aria-label={title}
			aria-modal="false"
			data-reader-tool=""
			data-reader-panel-side={side}
			data-exiting={closing}
			inert={inactive || closing}
			aria-hidden={inactive || closing || undefined}
		>
			<header>
				<h2>{title}</h2>
				<button
					type="button"
					aria-label={`关闭${title}`}
					className="reader-panel-close"
					data-tooltip={`关闭${title}`}
					onClick={onClose}
				>
					×
				</button>
			</header>
			<div className="reader-panel-body">{children}</div>
		</section>
	);
}
export function ReaderSettings({
	settings,
	ui,
	bookUi,
	onSettings,
	onUi,
	onBookUi,
	onReset,
	onClose,
	inactive,
	closing,
}: {
	settings: Settings;
	ui: ReaderUiPreferences;
	bookUi: BookUiPreferences;
	onSettings: (v: Settings) => void;
	onUi: (v: ReaderUiPreferences) => void;
	onBookUi: (v: BookUiPreferences) => void;
	onReset: () => void;
	onClose: () => void;
	inactive?: boolean;
	closing?: boolean;
}) {
	return (
		<ReaderPanel
			title="阅读设置"
			inactive={inactive}
			closing={closing}
			onClose={onClose}
		>
			<fieldset>
				<legend>纸面</legend>
				<div className="reader-options">
					{(["white", "black", "system"] as const).map((v, i) => (
						<button
							key={v}
							type="button"
							aria-pressed={ui.theme === v}
							onClick={() => onUi({ ...ui, theme: v })}
						>
							{["白", "黑", "跟随系统"][i]}
						</button>
					))}
				</div>
			</fieldset>
			<fieldset>
				<legend>工具栏</legend>
				<label>
					背景透明度 <output>{ui.toolbarTransparency}%</output>
					<input
						aria-label="工具栏背景透明度"
						aria-valuetext={`${ui.toolbarTransparency}%`}
						aria-describedby="reader-toolbar-transparency-hint"
						type="range"
						min="0"
						max="100"
						step="5"
						value={ui.toolbarTransparency}
						onChange={(e) =>
							onUi({ ...ui, toolbarTransparency: Number(e.target.value) })
						}
					/>
				</label>
				<p id="reader-toolbar-transparency-hint">
					同时调整顶部标题栏与底部工具栏背景；0% 不透明，100% 完全透明。
				</p>
			</fieldset>
			<fieldset>
				<legend>排版</legend>
				<label>
					文字方向
					<select
						aria-label="文字方向"
						value={settings.writing_mode}
						onChange={(e) =>
							onSettings({
								...settings,
								writing_mode: e.target.value as Settings["writing_mode"],
							})
						}
					>
						<option value="horizontal-tb">横排</option>
						<option value="vertical-rl">竖排</option>
					</select>
				</label>
				<label>
					字体
					<select
						aria-label="字体"
						value={bookUi.font}
						onChange={(e) =>
							onBookUi({
								...bookUi,
								font: e.target.value as BookUiPreferences["font"],
							})
						}
					>
						<option value="mincho">明朝体</option>
						<option value="gothic">黑体</option>
					</select>
				</label>
				<label>
					字号 <output>{settings.font_size}px</output>
					<input
						aria-label="字号"
						type="range"
						min="12"
						max="40"
						value={settings.font_size}
						onChange={(e) =>
							onSettings({ ...settings, font_size: Number(e.target.value) })
						}
					/>
				</label>
				<label>
					行距 <output>{settings.line_height.toFixed(1)}</output>
					<input
						aria-label="行距"
						type="range"
						min="1"
						max="3"
						step="0.1"
						value={settings.line_height}
						onChange={(e) =>
							onSettings({ ...settings, line_height: Number(e.target.value) })
						}
					/>
				</label>
				<label>
					正文宽度 <output>{bookUi.width}px</output>
					<input
						aria-label="正文宽度"
						type="range"
						min="560"
						max="1040"
						step="20"
						value={bookUi.width}
						disabled={settings.writing_mode === "vertical-rl"}
						onChange={(e) =>
							onBookUi({ ...bookUi, width: Number(e.target.value) })
						}
					/>
				</label>
				{settings.writing_mode === "vertical-rl" && (
					<p>正文宽度仅在横排生效。</p>
				)}
			</fieldset>
			<fieldset>
				<legend>注音范围</legend>
				<div className="reader-options">
					{(["original", "all"] as const).map((scope, i) => (
						<button
							key={scope}
							type="button"
							aria-pressed={(bookUi.rubyScope ?? "original") === scope}
							onClick={() => onBookUi({ ...bookUi, rubyScope: scope })}
						>
							{["原书", "全量"][i]}
						</button>
					))}
				</div>
			</fieldset>
			<fieldset>
				<legend>注音显示</legend>
				<div className="reader-options">
					{(["show", "on-demand", "hide"] as const).map((v, i) => (
						<button
							key={v}
							type="button"
							aria-pressed={bookUi.ruby === v}
							onClick={() => onBookUi({ ...bookUi, ruby: v })}
						>
							{["显示", "按需", "隐藏"][i]}
						</button>
					))}
				</div>
				<p>
					原书注音优先；全量补充未标注的汉字。按需时可悬停、轻点、选中或按 R
					显现。
				</p>
			</fieldset>
			<fieldset>
				<legend>正文标记</legend>
				<label className="reader-focus-label">
					<span>
						阅读记录下划线<small>在所有书籍中生效</small>
					</span>
					<input
						type="checkbox"
						aria-label="显示阅读记录下划线"
						checked={ui.marks.studySegmentUnderlines}
						onChange={(event) =>
							onUi({
								...ui,
								marks: {
									...ui.marks,
									studySegmentUnderlines: event.target.checked,
								},
							})
						}
					/>
				</label>
				<label className="reader-focus-label">
					<span>
						阅读记录页边入口<small>在所有书籍中生效</small>
					</span>
					<input
						type="checkbox"
						aria-label="显示阅读记录页边入口"
						checked={ui.marks.studySegmentMargins}
						onChange={(event) =>
							onUi({
								...ui,
								marks: {
									...ui.marks,
									studySegmentMargins: event.target.checked,
								},
							})
						}
					/>
				</label>
				<p>
					实线表示学习片段，虚线表示翻译；重叠处保留实线。页边空间不足时使用“本章记录”。隐藏标记不删除记录。
				</p>
			</fieldset>
			<label className="reader-focus-label">
				<span>
					专注阅读<small>静置后自动隐藏工具</small>
				</span>
				<input
					type="checkbox"
					aria-label="专注阅读"
					checked={ui.focus}
					onChange={(e) => onUi({ ...ui, focus: e.target.checked })}
				/>
			</label>
			<p>
				单击未标记正文收起，再次单击、移动鼠标或按 Tab
				唤出。方向键、空格和滚动不会唤出工具。
			</p>
			<button type="button" onClick={onReset}>
				恢复阅读设置默认值
			</button>
		</ReaderPanel>
	);
}

export function ReaderIcon({
	name,
}: {
	name: "toc" | "image" | "previous" | "next";
}) {
	const path = {
		toc: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
		image:
			"M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM3 16l5-5 5 5 3-3 5 5M15 8h.01",
		previous: "M7 5v14M18 5l-7 7 7 7",
		next: "M17 5v14M6 5l7 7-7 7",
	}[name];
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={path} />
		</svg>
	);
}
