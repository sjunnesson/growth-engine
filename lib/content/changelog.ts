// Shapes generated changelog copy into a content file for the website repo.
// One file per release tag; directory + format come from product.json.
import { renderContentFile, type ContentFile } from "@/lib/content/render";

export type ChangelogFile = ContentFile;

function slugify(tag: string) {
  return tag.replace(/^v/, "").replace(/[^\w.]+/g, "-");
}

export function buildChangelogFile(input: {
  tag: string;
  title: string;
  publishedAt: string;
  body: string; // generated markdown
  url: string; // UTM-tagged
}): ChangelogFile {
  const slug = slugify(input.tag);
  return renderContentFile(
    "changelog",
    slug,
    {
      tag: input.tag,
      slug,
      title: input.title,
      date: input.publishedAt,
      url: input.url,
      generatedAt: new Date().toISOString(),
    },
    input.body,
  );
}
