import { lazy } from "react";
import {
	createRoutesFromElements,
	Link,
	Navigate,
	Outlet,
	Route,
	useLocation,
	useParams,
} from "react-router";
import { MaterialsPage } from "./catalog/MaterialsPage";
import { PageBoundary } from "./navigation/PageBoundary";
import { readerSessionRoute } from "./navigation/reader-session-route";
import { Shell } from "./Shared";

const ReaderSessionHost = lazy(() =>
	import("./materials/ReaderSessionHost").then((page) => ({
		default: page.ReaderSessionHost,
	})),
);
const SegmentDetail = lazy(() =>
	import("./SegmentPage").then((page) => ({ default: page.SegmentDetail })),
);
const SettingsPage = lazy(() =>
	import("./settings/SettingsPage").then((page) => ({
		default: page.SettingsPage,
	})),
);
const SourceIndex = lazy(() =>
	import("./SourcePages").then((page) => ({ default: page.SourceIndex })),
);
const SourceDetail = lazy(() =>
	import("./SourcePages").then((page) => ({ default: page.SourceDetail })),
);
const BookDetailsPage = lazy(() =>
	import("./catalog/BookDetailsPage").then((page) => ({
		default: page.BookDetailsPage,
	})),
);

function SourceRoute() {
	const { id } = useParams();
	return <SourceDetail key={id} />;
}

function SegmentRoute() {
	const { id } = useParams();
	return <SegmentDetail key={id} />;
}

export function App() {
	const { pathname } = useLocation();
	const sessionRoute = readerSessionRoute(pathname);
	return (
		<>
			{sessionRoute && (
				<PageBoundary>
					<ReaderSessionHost />
				</PageBoundary>
			)}
			<PageBoundary key={pathname}>
				<Outlet />
			</PageBoundary>
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
