import { Link, Route, Routes } from "react-router";
import { SegmentDetail } from "./SegmentPage";
import { Shell } from "./Shared";
import { SourceDetail, SourceIndex } from "./SourcePages";
import { SettingsPage } from "./settings/SettingsPage";

export function App() {
	return (
		<Routes>
			<Route path="/" element={<SourceIndex />} />
			<Route path="/sources/:id" element={<SourceDetail />} />
			<Route path="/segments/:id" element={<SegmentDetail />} />
			<Route path="/settings" element={<SettingsPage />} />
			<Route
				path="*"
				element={
					<Shell>
						<div className="state-card">
							<h1>页面不存在</h1>
							<Link className="button secondary" to="/">
								返回来源目录
							</Link>
						</div>
					</Shell>
				}
			/>
		</Routes>
	);
}
