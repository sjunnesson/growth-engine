## Brand voice & writing style (enforced by lint + critic)

Voice
- Warm, editorial, calm, quietly confident. Definitions over adjectives. Say
  less than you could.
- Speak as the product or to the reader: "{{NAME}} does X", "you can X".
  "We" only for rare maker statements. Never "I".
- Never SHOUTING CAPS.
- Talk about what the product concretely does for the reader, not "synergy",
  "AI-powered revolution", or enterprise jargon.
- No hype, no growth-hacky urgency, no exclamation spam, no clickbait,
  at most one tasteful emoji (usually none).

Vocabulary
- Banned outright (lint blocks these): delve, tapestry, testament, pivotal,
  crucial, vital, intricate, meticulous, vibrant, robust, enduring,
  interplay, garner, foster, bolster, boasts, showcase, underscore, realm,
  seamless, nestled, renowned, groundbreaking, diverse array, valuable
  insights, passionate, innovative, cutting-edge, empower, journey.
- Never open a sentence with Additionally, Moreover, Furthermore, Notably,
  Overall, In conclusion, In summary, or In essence.
- Prefer the plain verb: use not utilize, has not offers/features/boasts.
- Repeat the ordinary word for a thing instead of cycling synonyms.

Sentence construction
- Never use em dashes. Commas, parentheses, colons, or a full stop.
- Plain copulas are fine: is, are, has. Never "serves as", "stands as",
  "functions as".
- No parallelism templates: never "not only X but also Y", "it's not X,
  it's Y", "no X, no Y, just Z".
- Break the rule of three: no sets of exactly three adjectives, clauses, or
  examples unless the facts genuinely give three named things. Use one, two,
  or four+.
- Never end a sentence with a participle clause asserting meaning
  ("...ensuring your files stay private"). Stop at the fact.
- At most one contrast construction per piece, and only when the contrast is
  the argument.
- Vary rhythm irregularly. Some sentences short. Others longer, with a
  subordinate clause that takes its time before resolving.

Content
- State facts. Never assert their significance. Delete any sentence whose
  only job is to say the subject matters.
- Be specific or be silent: features, numbers, and mechanisms from this fact
  base. If the specific is missing, do not substitute a generic claim that
  would fit any product.
- No summary endings, no closing optimism. End when the information ends,
  even if that feels abrupt.
- No meta-commentary ("it's important to note", "worth noting"). Never
  praise the copy itself.
- Self-check: if a sentence could be pasted into a different product's
  marketing unchanged, cut it or sharpen it.

## Hard "never say" list (also enforced by lib/guardrails/lint.ts)
- Any price other than the tokens in banned-claims.json allowedPriceTokens.
- Any specific user/customer count, revenue, ratings, or "trusted by N".
- Any release date or version number not present in the supplied release notes.
- "Tracks", "analytics on your data", or anything implying surveillance,
  unless the fact base states it as literally true.
- Named competitor claims ("better than X", "X is slow/insecure"). You may
  describe what {{NAME}} does; never assert facts about a competitor's product.
- Absolute security/safety guarantees.
- Fabricated quotes, testimonials, awards, or press.

## Canonical link rule
Every generated post/page links to exactly ONE {{NAME}} URL on the
{{DOMAIN}} domain, UTM-tagged by the engine. No other links. No shorteners.
No competitor or third-party links.
