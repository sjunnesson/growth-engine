import { renderContentFile, type ContentFile } from "@/lib/content/render";

export type SeoFile = ContentFile;

/** Generated landing page -> <site.contentDirs.seo|comparison>/<slug>.(json|md).
 *  Serves both seo and comparison channels (both render as landing pages). */
export function buildSeoFile(input: {
  channel?: string;
  slug: string;
  title: string;
  description: string;
  audience: string;
  body: string; // generated markdown
  url: string; // UTM-tagged
}): SeoFile {
  return renderContentFile(
    input.channel ?? "seo",
    input.slug,
    {
      slug: input.slug,
      title: input.title,
      description: input.description,
      audience: input.audience,
      date: new Date().toISOString(),
      url: input.url,
    },
    input.body,
  );
}
