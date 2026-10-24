import { describe, expect, it } from "vite-plus/test";

import { labelWebManifest } from "./webManifest.ts";

describe("labelWebManifest", () => {
  it("names the installed app after its environment and keeps the rest", () => {
    const labeled = JSON.parse(
      labelWebManifest('{"name":"T3 Code","short_name":"T3 Code","start_url":"/"}', "vps"),
    );
    expect(labeled).toEqual({ name: "T3 Code (vps)", short_name: "T3 Code (vps)", start_url: "/" });
  });
});
