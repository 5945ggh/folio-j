import { Component, type ReactNode, Suspense } from "react";
import { Loading, Shell } from "../Shared";

/** Keep this boundary stable inside a retained view; navigation must not reset it. */
export class PageBoundary extends Component<
	{ children: ReactNode },
	{ failed: boolean }
> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	render() {
		if (this.state.failed)
			return (
				<Shell>
					<div className="state-card" role="alert">
						<h1>页面暂时无法打开</h1>
						<p>请重新加载页面后重试。</p>
						<button
							type="button"
							className="button primary"
							onClick={() => window.location.reload()}
						>
							重新加载
						</button>
					</div>
				</Shell>
			);
		return <Suspense fallback={<Loading />}>{this.props.children}</Suspense>;
	}
}
