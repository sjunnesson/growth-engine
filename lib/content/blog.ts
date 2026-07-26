import { renderContentFile, type ContentFile } from "@/lib/content/render";

export type BlogFile = ContentFile;

/** Generated blog post -> <site.contentDirs.blog>/<slug>.(json|md) */
export function buildBlogFile(input: {
  slug: string;
  title: string;
  description: string;
  body: string; // generated markdown
  url: string; // UTM-tagged
}): BlogFile {
  // The template renders `title` as the page H1, so take the title FROM the
  // generated H1 and strip it from the body — otherwise the page shows a
  // titleCased slug ("Iphone Share Sheet") above the real headline.
  const m = input.body.trimStart().match(/^# (.+)\n+([\s\S]*)$/);
  const title = m ? m[1].trim() : input.title;
  const body = m ? m[2].trim() : input.body;
  return renderContentFile(
    "blog",
    input.slug,
    {
      slug: input.slug,
      title,
      description: input.description,
      date: new Date().toISOString(),
      url: input.url,
    },
    body,
  );
}
