import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { imageHref, safeHref } from "./links";

export const Markdown = memo(function Markdown({ text }: { text: string }) {
	return (
		<div className="analysis-markdown">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				skipHtml
				components={{
					a: ({ href, children }) => {
						const safe = safeHref(href);
						return safe ? (
							<a href={safe} target="_blank" rel="noopener noreferrer">
								{children}
							</a>
						) : (
							<span>{children}</span>
						);
					},
					img: ({ src, alt }) => {
						const safe = imageHref(src);
						return safe ? (
							<a href={safe} target="_blank" rel="noopener noreferrer">
								查看图片：{alt || "无说明"}
							</a>
						) : (
							<span>图片：{alt || "无说明"}</span>
						);
					},
				}}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
});
