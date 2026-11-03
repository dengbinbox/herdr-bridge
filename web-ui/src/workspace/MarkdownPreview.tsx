import { useMemo, type ReactNode } from "react";
import { lexer, type Token, type Tokens } from "marked";
import styles from "./workspace.module.css";
export function safeMarkdownLink(
  href: string,
): "external" | "anchor" | "relative" | null {
  if (
    /[\u0000-\u0020\u007f]/.test(href) ||
    href.startsWith("//") ||
    href.includes("\\")
  )
    return null;
  if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) return "external";
  if (href.startsWith("#")) return "anchor";
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) return null;
  return href ? "relative" : null;
}
function decodeEntities(text: string) {
  return text.replace(
    /&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi,
    (entity) => {
      // Only an entity, never user-provided tags, reaches this inert decoder.
      const decoder = document.createElement("textarea");
      decoder.innerHTML = entity;
      return decoder.value;
    },
  );
}
const headingID = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
export function MarkdownPreview({
  text,
  onFile,
}: {
  text: string;
  onFile?: (path: string) => void;
}) {
  const parsed = useMemo(() => {
    try {
      return { tokens: lexer(text, { gfm: true }), error: false };
    } catch {
      return { tokens: [], error: true };
    }
  }, [text]);
  let budget = 20000;
  function render(tokens: Token[] | undefined, depth = 0): ReactNode {
    if (!tokens || depth > 40) return null;
    return tokens.map((token, i) => {
      if (--budget < 0) return null;
      const children = () =>
        render((token as Tokens.Paragraph).tokens, depth + 1);
      switch (token.type) {
        case "space":
          return null;
        case "heading": {
          const t = token as Tokens.Heading,
            Tag = `h${t.depth}` as "h1";
          return (
            <Tag id={headingID(t.text)} key={i}>
              {children()}
            </Tag>
          );
        }
        case "paragraph":
          return <p key={i}>{children()}</p>;
        case "text":
        case "escape": {
          const t = token as Tokens.Text;
          return (
            <span key={i}>
              {t.tokens ? children() : decodeEntities(t.text)}
            </span>
          );
        }
        case "strong":
          return <strong key={i}>{children()}</strong>;
        case "em":
          return <em key={i}>{children()}</em>;
        case "del":
          return <del key={i}>{children()}</del>;
        case "br":
          return <br key={i} />;
        case "hr":
          return <hr key={i} />;
        case "codespan":
          return <code key={i}>{(token as Tokens.Codespan).text}</code>;
        case "code": {
          const t = token as Tokens.Code;
          return (
            <pre key={i}>
              <code data-language={t.lang?.split(/\s/)[0]}>{t.text}</code>
            </pre>
          );
        }
        case "blockquote":
          return <blockquote key={i}>{children()}</blockquote>;
        case "list": {
          const t = token as Tokens.List,
            Tag = t.ordered ? "ol" : "ul";
          return (
            <Tag key={i} start={t.ordered ? Number(t.start) : undefined}>
              {t.items.map((item, j) => (
                <li key={j} className={item.task ? styles.taskItem : undefined}>
                  {item.task && (
                    <input
                      type="checkbox"
                      checked={item.checked}
                      readOnly
                      disabled
                      aria-label={item.checked ? "已完成" : "未完成"}
                    />
                  )}{" "}
                  {render(item.tokens, depth + 1)}
                </li>
              ))}
            </Tag>
          );
        }
        case "table": {
          const t = token as Tokens.Table;
          return (
            <div className={styles.markdownTable} key={i}>
              <table>
                <thead>
                  <tr>
                    {t.header.map((c, j) => (
                      <th
                        key={j}
                        style={{ textAlign: t.align[j] || undefined }}
                      >
                        {render(c.tokens, depth + 1)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.map((row, j) => (
                    <tr key={j}>
                      {row.map((c, k) => (
                        <td
                          key={k}
                          style={{ textAlign: t.align[k] || undefined }}
                        >
                          {render(c.tokens, depth + 1)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        case "link": {
          const t = token as Tokens.Link,
            kind = safeMarkdownLink(t.href);
          if (kind === "external")
            return (
              <a
                key={i}
                href={t.href}
                target="_blank"
                rel="noopener noreferrer"
                title={t.title || undefined}
              >
                {children()}
              </a>
            );
          if (kind === "anchor")
            return (
              <a
                key={i}
                href={t.href}
                onClick={(e) => {
                  e.preventDefault();
                  let target: string;
                  try {
                    target = decodeURIComponent(t.href.slice(1));
                  } catch {
                    return;
                  }
                  e.currentTarget
                    .closest("article")
                    ?.querySelectorAll("[id]")
                    .forEach((el) => {
                      if (el.id === target)
                        el.scrollIntoView({ block: "nearest" });
                    });
                }}
              >
                {children()}
              </a>
            );
          if (kind === "relative" && onFile)
            return (
              <button
                className={styles.markdownLink}
                key={i}
                title={t.href}
                onClick={() => onFile(t.href)}
              >
                {children()}
              </button>
            );
          return <span key={i}>{children()}</span>;
        }
        case "image": {
          const t = token as Tokens.Image;
          return (
            <span className={styles.imagePlaceholder} key={i} title={t.href}>
              图片：{t.text || "未命名图片"}
            </span>
          );
        }
        case "html":
          return <code key={i}>{(token as Tokens.HTML).text}</code>;
        default:
          return <span key={i}>{token.raw}</span>;
      }
    });
  }
  return (
    <article className={styles.markdown} aria-label="Markdown 预览">
      {parsed.error ? <pre>{text}</pre> : render(parsed.tokens)}
      {budget < 0 && <p>内容较多，余下内容请切换源码查看。</p>}
    </article>
  );
}
