import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { LookupText } from "../dictionary/LookupText";
import { imageHref, safeHref } from "./links";

export const Markdown = memo(function Markdown({
	text,
	lookup = false,
}: {
	text: string;
	lookup?: boolean;
}) {
	return (
		<LookupText
			className="analysis-markdown"
			contentKey={text}
			enabled={lookup}
		>
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
		</LookupText>
	);
});
