import { BotIcon } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerSelectControl } from "./ComposerControl";
import { Select } from "../ui/select";

describe("ComposerSelectControl", () => {
  it("renders an icon-only accessible Build trigger without a chevron", () => {
    const markup = renderToStaticMarkup(
      <Select value="build">
        <ComposerSelectControl iconOnly aria-label="Build mode">
          <BotIcon data-composer-control-icon />
        </ComposerSelectControl>
      </Select>,
    );
    expect(markup).toContain('aria-label="Build mode"');
    expect(markup).toContain("data-composer-control-icon");
    expect(markup).not.toContain("lucide-chevron-down");
    expect(markup).not.toMatch(/>\s*Build\s*</);
  });
});
