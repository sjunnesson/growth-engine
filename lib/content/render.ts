// Shared serializer for generated content files committed into the website
// repo. Two target formats, chosen by product.json site.format:
//   "json"     — one JSON object per file; the site globs the directory at
//                build time (valid under a static output:"export" site).
//   "markdown" — YAML frontmatter + markdown body (Astro/Hugo/MDX-style
//                content collections).
import { product } from "@/lib/product";

export interface ContentFile {
  path: string;
  content: string;
  slug: string;
}

function yamlValue(v: unknown): string {
  // JSON string/number/bool encoding is valid YAML for scalar values.
  return JSON.stringify(v);
}

/** Serialize one content file for `channel`, fields + body, in the product's
 *  configured format and directory. */
export function renderContentFile(
  channel: string,
  slug: string,
  fields: Record<string, unknown>,
  body: string,
): ContentFile {
  const cfg = product();
  const dir = cfg.site.contentDirs[channel] ?? `content/${channel}`;
  const meta = { ...fields, generatedBy: `${cfg.slug}-growth` };

  if (cfg.site.format === "markdown") {
    const fm = Object.entries(meta)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}: ${yamlValue(v)}`)
      .join("\n");
    return {
      slug,
      path: `${dir}/${slug}.md`,
      content: `---\n${fm}\n---\n\n${body.trim()}\n`,
    };
  }

  return {
    slug,
    path: `${dir}/${slug}.json`,
    content: JSON.stringify({ ...meta, body }, null, 2) + "\n",
  };
}
