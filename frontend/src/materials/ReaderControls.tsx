import { type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import type { Settings } from "./api";
import { restoreReaderPanelFocus } from "./motion";
import {
	type BookUiPreferences,
	DEFAULT_DICTIONARY_OPACITY,
	MIN_DICTIONARY_OPACITY,
	type ReaderUiPreferences,
} from "./preferences";
import { ReaderCopySettings } from "./ReaderCopySettings";
import { ReaderSettingsReset } from "./ReaderSettingsReset";
import {
	type ReaderSettingsExpanded,
	type ReaderSettingsGroup,
	typographySummary,
} from "./reader-settings";
import type { ReaderCopyEditor } from "./use-reader-copy-editor";
import "./reader-settings.css";

export function ReaderPanel({
	title,
	side = "right",
	onClose,
	inactive = false,
	closing = false,
	children,
	bodyScrollTop,
	onBodyScrollTop,
}: {
	title: string;
	side?: "right" | "left";
	onClose: () => void;
	inactive?: boolean;
	closing?: boolean;
	children: ReactNode;
	bodyScrollTop?: number;
	onBodyScrollTop?: (top: number) => void;
}) {
	const root = useRef<HTMLElement>(null);
	const body = useRef<HTMLDivElement>(null);
	const initialScrollTop = useRef(bodyScrollTop);
	useLayoutEffect(() => {
		if (body.current && initialScrollTop.current !== undefined)
			body.current.scrollTop = initialScrollTop.current;
	}, []);
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
			<div
				ref={body}
				className="reader-panel-body"
				onScroll={
					onBodyScrollTop
						? (event) => onBodyScrollTop(event.currentTarget.scrollTop)
						: undefined
				}
			>
				{children}
			</div>
		</section>
	);
}
function SettingsDisclosure({
	label,
	summary,
	open,
	onOpen,
	children,
}: {
	label: string;
	summary?: string;
	open: boolean;
	onOpen: (open: boolean) => void;
	children: ReactNode;
}) {
	return (
		<details
			className="reader-settings-disclosure"
			open={open}
			onToggle={(event) => {
				if (event.currentTarget.open !== open) onOpen(event.currentTarget.open);
			}}
		>
			<summary>
				<span className="reader-settings-disclosure-label">{label}</span>
				{summary && <span className="reader-settings-summary">{summary}</span>}
			</summary>
			<div className="reader-settings-more">{children}</div>
		</details>
	);
}
export function ReaderSettings({
	settings,
	ui,
	bookUi,
	onSettings,
	onUi,
	onBookUi,
	onResetGroup,
	onClose,
	inactive,
	closing,
	copyEditor,
	expanded,
	onExpandedChange,
	scrollTop,
	onScrollTop,
	rubyStatus,
}: {
	settings: Settings;
	ui: ReaderUiPreferences;
	bookUi: BookUiPreferences;
	onSettings: (v: Settings) => void;
	onUi: (v: ReaderUiPreferences) => void;
	onBookUi: (v: BookUiPreferences) => void;
	onResetGroup: (group: ReaderSettingsGroup) => void;
	onClose: () => void;
	inactive?: boolean;
	closing?: boolean;
	copyEditor: ReaderCopyEditor;
	expanded: ReaderSettingsExpanded;
	onExpandedChange: (next: ReaderSettingsExpanded) => void;
	scrollTop?: number;
	onScrollTop?: (top: number) => void;
	rubyStatus?: ReactNode;
}) {
	const setExpanded = (key: keyof ReaderSettingsExpanded, open: boolean) =>
		onExpandedChange({ ...expanded, [key]: open });
	return (
		<ReaderPanel
			title="阅读设置"
			inactive={inactive}
			closing={closing}
			onClose={onClose}
			bodyScrollTop={scrollTop}
			onBodyScrollTop={onScrollTop}
		>
			<div className="reader-settings">
				<section
					className="reader-settings-group"
					data-reader-settings-group="typography"
					aria-labelledby="reader-typography-title"
				>
					<div className="reader-settings-heading">
						<h3 id="reader-typography-title">排版</h3>
						<span
							className="reader-settings-scope"
							data-tooltip="字号、行距和文字方向随本书阅读位置保存到资料库；连接同一资料库的浏览器共用。"
						>
							本书 · 资料库
						</span>
						<ReaderSettingsReset
							label="排版"
							description="恢复字号、方向、行距、字体与正文宽度。"
							onReset={() => onResetGroup("typography")}
						/>
					</div>
					<label className="reader-settings-slider">
						字号{" "}
						<output>
							{settings.font_size}
							<span> px</span>
						</output>
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
					<div className="reader-field">
						<span>文字方向</span>
						<fieldset className="reader-options" aria-label="文字方向">
							{(["horizontal-tb", "vertical-rl"] as const).map((v, i) => (
								<button
									key={v}
									type="button"
									aria-pressed={settings.writing_mode === v}
									onClick={() => onSettings({ ...settings, writing_mode: v })}
								>
									{["横排", "竖排"][i]}
								</button>
							))}
						</fieldset>
					</div>
					<SettingsDisclosure
						label="更多排版"
						summary={typographySummary(settings, bookUi)}
						open={expanded.typography}
						onOpen={(open) => setExpanded("typography", open)}
					>
						<label className="reader-settings-slider">
							行距 <output>{settings.line_height.toFixed(1)}</output>
							<input
								aria-label="行距"
								type="range"
								min="1"
								max="3"
								step="0.1"
								value={settings.line_height}
								onChange={(e) =>
									onSettings({
										...settings,
										line_height: Number(e.target.value),
									})
								}
							/>
						</label>
						<div className="reader-field">
							<span className="reader-settings-field-label">
								字体
								<span
									className="reader-settings-scope"
									data-tooltip="字体仅对本书当前版本生效，保存在此浏览器中。"
								>
									此浏览器
								</span>
							</span>
							<fieldset className="reader-options" aria-label="字体">
								{(["mincho", "gothic"] as const).map((v, i) => (
									<button
										key={v}
										type="button"
										aria-pressed={bookUi.font === v}
										onClick={() => onBookUi({ ...bookUi, font: v })}
									>
										{["明朝体", "黑体"][i]}
									</button>
								))}
							</fieldset>
						</div>
						<label className="reader-settings-slider">
							<span className="reader-settings-field-label">
								正文宽度
								<span
									className="reader-settings-scope"
									data-tooltip="正文宽度仅对本书当前版本生效，保存在此浏览器中。"
								>
									此浏览器
								</span>
							</span>
							<output>
								{bookUi.width}
								<span> px</span>
							</output>
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
							<p>正文宽度仅在横排生效，当前值会保留。</p>
						)}
					</SettingsDisclosure>
				</section>
				<section
					className="reader-settings-group"
					data-reader-settings-group="ruby"
					aria-labelledby="reader-ruby-title"
				>
					<div className="reader-settings-heading">
						<h3 id="reader-ruby-title">注音</h3>
						<span
							className="reader-settings-scope"
							data-tooltip="注音显示与范围仅对本书当前版本生效，保存在此浏览器中。"
						>
							本书 · 此浏览器
						</span>
						<ReaderSettingsReset
							label="注音"
							description="恢复原书注音与显示方式。"
							onReset={() => onResetGroup("ruby")}
						/>
					</div>
					<div className="reader-field">
						<span>显示方式</span>
						<fieldset className="reader-options" aria-label="注音显示">
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
						</fieldset>
					</div>
					{rubyStatus}
					<div className="reader-field">
						<span>注音范围</span>
						<fieldset className="reader-options" aria-label="注音范围">
							{(["original", "all"] as const).map((v, i) => (
								<button
									key={v}
									type="button"
									aria-pressed={(bookUi.rubyScope ?? "original") === v}
									onClick={() => onBookUi({ ...bookUi, rubyScope: v })}
								>
									{["原书", "全量"][i]}
								</button>
							))}
						</fieldset>
					</div>
					<SettingsDisclosure
						label="注音使用说明"
						open={expanded.rubyHelp}
						onOpen={(open) => setExpanded("rubyHelp", open)}
					>
						<p>
							原书注音优先；全量补充未标注的汉字。按需时可悬停、轻点、选中或按 R
							显现。
						</p>
					</SettingsDisclosure>
				</section>
				<section
					className="reader-settings-group"
					data-reader-settings-group="interface"
					aria-labelledby="reader-interface-title"
				>
					<div className="reader-settings-heading">
						<h3 id="reader-interface-title">阅读界面</h3>
						<span
							className="reader-settings-scope"
							data-tooltip="对所有书籍生效，保存在此浏览器中；其他浏览器需另行设置。"
						>
							所有书籍 · 此浏览器
						</span>
						<ReaderSettingsReset
							label="阅读界面"
							description="恢复纸面、工具栏与浮窗不透明度及记录显示。"
							onReset={() => onResetGroup("interface")}
						/>
					</div>
					<div className="reader-field">
						<span>纸面</span>
						<fieldset className="reader-options" aria-label="纸面主题">
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
						</fieldset>
					</div>
					<SettingsDisclosure
						label="更多界面设置"
						summary={`下划线${ui.marks.studySegmentUnderlines ? "开" : "关"} · 页边入口${ui.marks.studySegmentMargins ? "开" : "关"}`}
						open={expanded.interface}
						onOpen={(open) => setExpanded("interface", open)}
					>
						<label className="reader-settings-slider">
							工具栏不透明度 <output>{ui.toolbarOpacity}%</output>
							<input
								aria-label="工具栏背景不透明度"
								aria-valuetext={`${ui.toolbarOpacity}%`}
								type="range"
								min="0"
								max="100"
								step="5"
								value={ui.toolbarOpacity}
								onChange={(e) =>
									onUi({ ...ui, toolbarOpacity: Number(e.target.value) })
								}
							/>
						</label>
						<label className="reader-settings-slider">
							浮窗背景不透明度
							<output>
								{ui.dictionaryOpacity ?? DEFAULT_DICTIONARY_OPACITY}%
							</output>
							<input
								aria-label="浮窗背景不透明度"
								aria-valuetext={`${ui.dictionaryOpacity ?? DEFAULT_DICTIONARY_OPACITY}%`}
								aria-describedby="reader-popover-opacity-help"
								type="range"
								min={MIN_DICTIONARY_OPACITY}
								max="100"
								step="1"
								value={ui.dictionaryOpacity ?? DEFAULT_DICTIONARY_OPACITY}
								onChange={(event) =>
									onUi({ ...ui, dictionaryOpacity: Number(event.target.value) })
								}
							/>
						</label>
						<p id="reader-popover-opacity-help">
							选区工具栏、词卡、学习片段、翻译与记录列表共用；展开阅读使用实底。
						</p>
						<label className="reader-settings-toggle">
							<span>展示阅读记录下划线</span>
							<input
								type="checkbox"
								aria-label="展示阅读记录下划线"
								checked={ui.marks.studySegmentUnderlines}
								onChange={(e) =>
									onUi({
										...ui,
										marks: {
											...ui.marks,
											studySegmentUnderlines: e.target.checked,
										},
									})
								}
							/>
						</label>
						<label className="reader-settings-toggle">
							<span>展示阅读记录页边入口</span>
							<input
								type="checkbox"
								aria-label="展示阅读记录页边入口"
								checked={ui.marks.studySegmentMargins}
								onChange={(e) =>
									onUi({
										...ui,
										marks: {
											...ui.marks,
											studySegmentMargins: e.target.checked,
										},
									})
								}
							/>
						</label>
						<SettingsDisclosure
							label="工具与阅读记录说明"
							open={expanded.interfaceHelp}
							onOpen={(open) => setExpanded("interfaceHelp", open)}
						>
							<p>
								单击未标记正文收起工具，再次单击、移动鼠标或按 Tab
								唤出。方向键、空格和滚动不会唤出工具。不透明度同时用于顶部与底部工具栏。
							</p>
							<p>
								实线表示学习片段，虚线表示翻译；重叠处保留实线。页边空间不足时使用“本章记录”。隐藏标记不删除记录。纸面独立于应用外观。
							</p>
						</SettingsDisclosure>
					</SettingsDisclosure>
				</section>
				<ReaderCopySettings
					editor={copyEditor}
					expanded={expanded}
					onExpandedChange={onExpandedChange}
				/>
			</div>
		</ReaderPanel>
	);
}

export function ReaderIcon({
	name,
}: {
	name: "toc" | "bookmark" | "image" | "previous" | "next";
}) {
	const path = {
		bookmark: "M6 3h12v18l-6-4-6 4V3zM9 8h6M12 5v6",
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
