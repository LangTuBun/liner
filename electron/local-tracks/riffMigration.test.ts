import { describe, expect, it } from "vitest";
import { tidyTitle, toPatch } from "./riffMigration";

describe("riffMigration", () => {
  it("drops the artist prefix and youtube noise from a title", () => {
    expect(
      tidyTitle("Lil Peep - nuts (Official Audio)", "Lil Peep"),
    ).toBe("nuts");
    expect(tidyTitle("Lover Girl", "Laufey")).toBe("Lover Girl");
  });

  it("keeps riff's match key and maps its hi-res verdict", () => {
    const patch = toPatch({
      title: "x",
      artist: "y",
      matchKey: "y\u0000x",
      hiRes: { verdict: "hires" },
    });
    expect(patch).toMatchObject({
      matchKey: "y\u0000x",
      hiRes: "hires",
      source: "soulseek",
    });
  });

  it("derives a key when riff stored none", () => {
    expect(toPatch({ title: "Lover Girl", artist: "Laufey" }).matchKey).toBe(
      "laufey\u0000lover girl",
    );
  });
});
