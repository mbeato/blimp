// GitHub trending for the feed (docs/DESIGN.md, "Feed"): today's trending repos (25), read off
// github.com/trending with Bun's HTMLRewriter (there's no API, so a change to the page breaks this; finding no repos
// says so on the caught-up card), and the start of a new repo's README from GitHub's API.

import { FeedError, type Get, getText } from "./net";
import type { Found } from "./store";
import { decode } from "./text";

export const TRENDING = "https://github.com/trending?since=daily";
export const readmeUrl = (repo: string) => `https://api.github.com/repos/${repo}/readme`;

export async function parseTrending(html: string): Promise<Found[]> {
  const repos: { name: string; description: string; today: string }[] = [];
  let cur: (typeof repos)[number] | undefined;
  await new HTMLRewriter()
    .on("article.Box-row", {
      element() {
        repos.push((cur = { name: "", description: "", today: "" }));
      },
    })
    .on("article.Box-row h2 a", {
      element(e) {
        if (cur) cur.name = (e.getAttribute("href") ?? "").replace(/^\//, "");
      },
    })
    .on("article.Box-row > p", {
      text(t) {
        if (cur) cur.description += t.text;
      },
    })
    .on("article.Box-row span.float-sm-right", {
      text(t) {
        if (cur) cur.today += t.text;
      },
    })
    .transform(new Response(html))
    .text();
  return repos
    .filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r.name))
    .slice(0, 25)
    .map((r, i): Found => {
      const today = Number(r.today.replace(/\D/g, ""));
      const description = decode(r.description).replace(/\s+/g, " ").trim();
      return {
        kind: "github",
        source: "GitHub",
        rank: i + 1,
        url: `https://github.com/${r.name}`,
        title: r.name,
        ...(today > 0 && { score: today }),
        ...(description && { text: description }),
        image: `https://opengraph.githubassets.com/1/${r.name}`,
        ref: r.name,
      };
    });
}

export async function readGithub(get: Get): Promise<Found[]> {
  const repos = await parseTrending(await getText(get, TRENDING));
  if (!repos.length) throw new FeedError("no repos on the page");
  return repos;
}

// The README as it's written (usually Markdown), for the model.
export const readReadme = (get: Get, repo: string) => getText(get, readmeUrl(repo), { headers: { Accept: "application/vnd.github.raw+json" } });
