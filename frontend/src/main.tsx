import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { App } from "./App";
import "./styles.css";
import "./catalog/source-content.css";
import "./catalog/sources-s2.css";
import "./catalog/import-dialog.css";

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");
const router = createBrowserRouter([{ path: "*", element: <App /> }]);

createRoot(root).render(
	<QueryClientProvider client={queryClient}>
		<RouterProvider router={router} />
	</QueryClientProvider>,
);
