import { useQuery } from "@tanstack/react-query";
import { api } from "./api/client";

async function getHealth() {
	const { data, error } = await api.GET("/api/health");
	if (error || !data) {
		throw new Error("健康检查失败");
	}
	return data;
}

export function App() {
	const health = useQuery({ queryKey: ["health"], queryFn: getHealth });
	const connected = health.isSuccess && health.data.status === "ok";

	return (
		<div className="app-shell">
			<header className="topbar">
				<div className="brand">
					<span className="brand-mark" aria-hidden="true">
						文
					</span>
					<span>Folio-J</span>
				</div>
				<span className="topbar-label">开发环境</span>
			</header>

			<main className="page-content">
				<div className="page-heading">
					<div className="eyebrow">WORKSPACE / 01</div>
					<h1>环境已就绪，内容正在搭建。</h1>
					<p>这里将逐步成为围绕日语原文阅读、讨论和整理讲解的工作台。</p>
				</div>

				<section className="status-card" aria-labelledby="service-title">
					<div className="card-header">
						<div>
							<div className="section-label">SERVICE STATUS</div>
							<h2 id="service-title">后端连接</h2>
						</div>
						<span
							className={`status-pill ${connected ? "connected" : health.isError ? "disconnected" : "checking"}`}
						>
							<span className="status-dot" aria-hidden="true" />
							{connected ? "已连接" : health.isError ? "连接失败" : "检查中"}
						</span>
					</div>
					<div className="card-body" aria-live="polite">
						<div className="endpoint-row">
							<span>健康检查</span>
							<code>GET /api/health</code>
						</div>
						<p className="status-message">
							{connected
								? "前端已连接到本地 API，开发服务可以正常协作。"
								: health.isError
									? "暂时无法连接后端。确认 API 已启动后，可以重试。"
									: "正在检查本地 API 连接…"}
						</p>
						{health.isError && (
							<p className="error-detail">{health.error.message}</p>
						)}
						<button
							type="button"
							className="refresh-button"
							onClick={() => void health.refetch()}
							disabled={health.isFetching}
						>
							<span aria-hidden="true">↻</span>
							{health.isFetching
								? "检查中…"
								: connected
									? "刷新状态"
									: "重试连接"}
						</button>
					</div>
				</section>

				<div className="next-note">
					<div className="note-rule" />
					<p>
						<span>接下来</span> 素材阅读与 Agent 协作能力将在后续版本中实现。
					</p>
				</div>
			</main>
			<footer className="footer">
				FOLIO-J <span>·</span> JAPANESE LEARNING WORKSPACE
			</footer>
		</div>
	);
}
