import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { App, appRoutes } from "./App";
import { readerResourceCache } from "./materials/reader-resource-cache";
import { startAppTheme } from "./theme/browser";
import "./styles.css";
import "./catalog/source-content.css";
import "./catalog/sources-s2.css";
import "./catalog/import-dialog.css";

startAppTheme();

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});
readerResourceCache(queryClient);

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");
const router = createBrowserRouter([
	{ id: "app", path: "/", element: <App />, children: appRoutes },
]);

createRoot(root).render(
	<QueryClientProvider client={queryClient}>
		<RouterProvider router={router} />
	</QueryClientProvider>,
);
