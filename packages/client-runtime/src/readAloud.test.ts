import { describe, expect, it } from "vite-plus/test";

import { speechTextFromMarkdown } from "./readAloud.ts";

describe("speechTextFromMarkdown", () => {
  it("reads prose, headings, lists, and link labels without speaking Markdown or code", () => {
    expect(
      speechTextFromMarkdown(`
# Result

The **repair** works. See [the guide](https://example.com/guide).

- First step
- Second step

\`\`\`sh
rm -rf /tmp/example
\`\`\`

    console.log("also code")

Done.
`),
    ).toBe("Result.\n\nThe repair works. See the guide.\n\nFirst step.\n\nSecond step.\n\nDone.");
  });

  it("omits technical content, hidden metadata, and bare URLs while preserving surrounding prose", () => {
    expect(
      speechTextFromMarkdown(`
Read this, \`npm install\`, and ~~obsolete advice~~. ![diagram](image.png)

| Command | Output |
| --- | --- |
| run | tool output |

The formula is $x^2 + y^2$.

$$
\\int_0^1 x dx
$$

See https://example.com/long/path and [the docs](https://example.com/docs).[^1]

[^1]: Reference metadata

<details>
<summary>Raw tool output</summary>

Hidden logs

</details>

<oai-mem-citation>
MEMORY.md:1-4|note=[private metadata]
</oai-mem-citation>

:codex-file-citation{path="src/main.ts" line_start=1 line_end=4}

::artifact-template{displayName="Template" skillDirectory="/tmp/skill"}

Finished.
`),
    ).toBe("Read this, and.\n\nThe formula is.\n\nSee and the docs.\n\nFinished.");
  });
});
