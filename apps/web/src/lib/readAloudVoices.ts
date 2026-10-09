import type { ReadAloudVoice } from "@t3tools/contracts";

export interface ReadAloudVoiceInfo {
  readonly name: string;
  readonly accent: "American" | "British";
  readonly gender: "Female" | "Male";
  /** Kokoro's published overall grade; lower grades sound noticeably less natural. */
  readonly grade: string;
}

/** Display metadata mirrored from kokoro-js, which is too heavy to import outside the speech worker. */
export const READ_ALOUD_VOICE_INFO: Record<ReadAloudVoice, ReadAloudVoiceInfo> = {
  af_heart: { name: "Heart", accent: "American", gender: "Female", grade: "A" },
  af_alloy: { name: "Alloy", accent: "American", gender: "Female", grade: "C" },
  af_aoede: { name: "Aoede", accent: "American", gender: "Female", grade: "C+" },
  af_bella: { name: "Bella", accent: "American", gender: "Female", grade: "A-" },
  af_jessica: { name: "Jessica", accent: "American", gender: "Female", grade: "D" },
  af_kore: { name: "Kore", accent: "American", gender: "Female", grade: "C+" },
  af_nicole: { name: "Nicole", accent: "American", gender: "Female", grade: "B-" },
  af_nova: { name: "Nova", accent: "American", gender: "Female", grade: "C" },
  af_river: { name: "River", accent: "American", gender: "Female", grade: "D" },
  af_sarah: { name: "Sarah", accent: "American", gender: "Female", grade: "C+" },
  af_sky: { name: "Sky", accent: "American", gender: "Female", grade: "C-" },
  am_adam: { name: "Adam", accent: "American", gender: "Male", grade: "F+" },
  am_echo: { name: "Echo", accent: "American", gender: "Male", grade: "D" },
  am_eric: { name: "Eric", accent: "American", gender: "Male", grade: "D" },
  am_fenrir: { name: "Fenrir", accent: "American", gender: "Male", grade: "C+" },
  am_liam: { name: "Liam", accent: "American", gender: "Male", grade: "D" },
  am_michael: { name: "Michael", accent: "American", gender: "Male", grade: "C+" },
  am_onyx: { name: "Onyx", accent: "American", gender: "Male", grade: "D" },
  am_puck: { name: "Puck", accent: "American", gender: "Male", grade: "C+" },
  am_santa: { name: "Santa", accent: "American", gender: "Male", grade: "D-" },
  bf_alice: { name: "Alice", accent: "British", gender: "Female", grade: "D" },
  bf_emma: { name: "Emma", accent: "British", gender: "Female", grade: "B-" },
  bf_isabella: { name: "Isabella", accent: "British", gender: "Female", grade: "C" },
  bf_lily: { name: "Lily", accent: "British", gender: "Female", grade: "D" },
  bm_daniel: { name: "Daniel", accent: "British", gender: "Male", grade: "D" },
  bm_fable: { name: "Fable", accent: "British", gender: "Male", grade: "C" },
  bm_george: { name: "George", accent: "British", gender: "Male", grade: "C" },
  bm_lewis: { name: "Lewis", accent: "British", gender: "Male", grade: "D+" },
};
