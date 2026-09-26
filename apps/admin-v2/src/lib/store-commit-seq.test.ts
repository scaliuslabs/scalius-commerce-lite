import { describe, expect, it, vi } from "vitest";
import { noteStoreCommitSeq, readStoreCommitSeq, subscribeStoreCommitSeq } from "./store-commit-seq";

describe("store commit seq", () => {
  it("keeps the newest clock a write answered and tells subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeStoreCommitSeq(listener);
    noteStoreCommitSeq(new Headers({ "X-Scalius-Commit-Seq": "12" }));
    noteStoreCommitSeq(new Headers({ "X-Scalius-Commit-Seq": "9" }));
    noteStoreCommitSeq(new Headers({ "X-Scalius-Commit-Seq": "nope" }));
    noteStoreCommitSeq(new Headers());
    expect(readStoreCommitSeq()).toBe(12);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    noteStoreCommitSeq(new Headers({ "X-Scalius-Commit-Seq": "13" }));
    expect(readStoreCommitSeq()).toBe(13);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
