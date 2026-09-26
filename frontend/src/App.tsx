import { Link, Route, Routes } from "react-router";
import { SegmentDetail } from "./SegmentPage";
import { Shell } from "./Shared";
import { SourceDetail, SourceIndex } from "./SourcePages";

export function App() {
	return (
		<Routes>
			<Route path="/" element={<SourceIndex />} />
			<Route path="/sources/:id" element={<SourceDetail />} />
			<Route path="/segments/:id" element={<SegmentDetail />} />
			<Route
				path="*"
				element={
					<Shell>
						<div className="state-card">
							<h1>页面不存在</h1>
							<Link className="button secondary" to="/">
								返回素材目录
							</Link>
						</div>
					</Shell>
				}
			/>
		</Routes>
	);
}
