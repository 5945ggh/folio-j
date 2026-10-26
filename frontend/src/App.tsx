import {
	createRoutesFromElements,
	Link,
	Navigate,
	Outlet,
	Route,
	useParams,
} from "react-router";
import { BookDetailsPage } from "./catalog/BookDetailsPage";
import { MaterialsPage } from "./catalog/MaterialsPage";
import { ReaderSessionHost } from "./materials/ReaderSessionHost";
import { SegmentDetail } from "./SegmentPage";
import { Shell } from "./Shared";
import { SourceDetail, SourceIndex } from "./SourcePages";
import { SettingsPage } from "./settings/SettingsPage";

function SourceRoute() {
	const { id } = useParams();
	return <SourceDetail key={id} />;
}

function SegmentRoute() {
	const { id } = useParams();
	return <SegmentDetail key={id} />;
}

export function App() {
	return (
		<>
			<ReaderSessionHost />
			<Outlet />
		</>
	);
}

// Register pages with the data router so Link/useNavigate options reach it.
export const appRoutes = createRoutesFromElements(
	<>
		<Route index element={<Navigate to="/materials?type=book" replace />} />
		<Route path="/materials" element={<MaterialsPage />} />
		<Route path="/sources" element={<SourceIndex />} />
		<Route path="/sources/:id" element={<SourceRoute />} />
		<Route path="/materials/:id/details" element={<BookDetailsPage />} />
		<Route path="/materials/:id" element={null} />
		<Route path="/segments/:id" element={<SegmentRoute />} />
		<Route path="/settings" element={<SettingsPage />} />
		<Route
			path="*"
			element={
				<Shell>
					<div className="state-card">
						<h1>页面不存在</h1>
						<Link className="button secondary" to="/sources">
							返回来源目录
						</Link>
					</div>
				</Shell>
			}
		/>
	</>,
);
