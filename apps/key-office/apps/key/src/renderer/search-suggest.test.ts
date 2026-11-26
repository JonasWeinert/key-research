import { describe, expect, it } from "vitest";
import { restAfterPick } from "./search-suggest";

describe("picking a reading of the query while typing on", () => {
  it("keeps what was typed after the reading was made", () => {
    expect(restAfterPick("malaria", "2020 malaria", "2020 malaria treat")).toBe("malaria treat");
    expect(restAfterPick("", "#covid", "#covid vacc")).toBe("vacc");
    expect(restAfterPick("mal", "2020 mal", "2020 malaria")).toBe("malaria");
  });
  it("uses the reading's rest when nothing more was typed, or the text changed", () => {
    expect(restAfterPick("malaria", "2020 malaria", "2020 malaria ")).toBe("malaria");
    expect(restAfterPick("malaria", "2020 malaria", "2021")).toBe("malaria");
  });
});
