/** The coordinator writes Slack mrkdwn; Telegram takes a subset of HTML and at most 4096 characters per message. */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;");
const EDGE_BEFORE = "(^|[\\s(\\[])";
const EDGE_AFTER = "(?=$|[\\s).,!?:;\\]])";
const span = (mark: string, tag: string) =>
  [new RegExp(`${EDGE_BEFORE}\\${mark}(?=\\S)([^${mark}\\n]*?\\S)\\${mark}${EDGE_AFTER}`, "gm"), `$1<${tag}>$2</${tag}>`] as const;
const SPANS = [span("*", "b"), span("_", "i"), span("~", "s")];

/** Slack mrkdwn (plus the Markdown a model slips into: **bold**, [label](url)) to Telegram HTML. */
export function toTelegramHtml(md: string): string {
  const kept: string[] = [];
  const keep = (html: string) => `\u0000${kept.push(html) - 1}\u0000`;
  const link = (url: string, label: string) => keep(`<a href="${escAttr(url)}">${esc(label)}</a>`);
  let s = md
    .replace(/```(?:[\w-]*\n)?([\s\S]*?)```/g, (_, code: string) => keep(`<pre>${esc(code.replace(/\n$/, ""))}</pre>`))
    .replace(/`([^`\n]+)`/g, (_, code: string) => keep(`<code>${esc(code)}</code>`))
    .replace(/<(https?:\/\/[^|>\s]+)\|([^>]+)>/g, (_, url: string, label: string) => link(url, label))
    .replace(/<(https?:\/\/[^>\s]+)>/g, (_, url: string) => link(url, url))
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label: string, url: string) => link(url, label))
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*");
  s = esc(s);
  for (const [re, to] of SPANS) s = s.replace(re, to);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)]!);
}

const fences = (s: string) => s.match(/```/g)?.length ?? 0;

/** Split at line breaks, leaving room for the HTML tags. A code block cut in two is closed and reopened. */
export function splitText(text: string, max = 3500): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = rest.lastIndexOf("\n", max);
    const at = cut > max / 2 ? cut : max;
    let part = rest.slice(0, at);
    rest = rest.slice(at).replace(/^\n/, "");
    if (fences(part) % 2) {
      part += "\n```";
      rest = "```\n" + rest;
    }
    parts.push(part);
  }
  parts.push(rest);
  return parts;
}
