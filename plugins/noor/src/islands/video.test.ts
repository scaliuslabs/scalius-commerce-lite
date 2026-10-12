// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import videoIsland from "./video";

let cleanup: void | (() => void);
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function mount(reduced: boolean, blocked = false) {
  const motion = Object.assign(new EventTarget(), { matches: reduced });
  vi.stubGlobal("matchMedia", () => motion);
  document.body.innerHTML = "<div><video controls></video></div>";
  const video = document.querySelector("video")!;
  const play = vi.fn(() => blocked ? Promise.reject(new Error("NotAllowedError")) : Promise.resolve());
  const pause = vi.fn();
  video.play = play;
  video.pause = pause;
  cleanup = videoIsland.mount(video.parentElement!, undefined, {} as never);
  return { video, play, pause, motion };
}

it("starts muted video only when motion is allowed", () => {
  const { video, play, pause, motion } = mount(false);
  expect(video.muted).toBe(true);
  expect(play).toHaveBeenCalledOnce();
  Object.assign(motion, { matches: true });
  motion.dispatchEvent(new Event("change"));
  expect(pause).toHaveBeenCalledOnce();
});

it("leaves reduced-motion video paused with native play controls", () => {
  const { video, play } = mount(true);
  expect(play).not.toHaveBeenCalled();
  expect(video.controls).toBe(true);
});

it("leaves native play available when browser autoplay is blocked", async () => {
  const { video, play } = mount(false, true);
  await Promise.resolve();
  expect(play).toHaveBeenCalledOnce();
  expect(video.controls).toBe(true);
});
