// The steps of "use This Mac": try the blimpd on this Mac; when it isn't set up (or doesn't
// answer), install it and try again. Its connect and install are passed in, so the steps are
// tested without the app.

import { errorText, thisMac } from "./connection";
import { canInstall } from "./hints";

export type Step = "connect" | "install";

export async function setUpThisMac(d: { connect: () => Promise<unknown>; install: () => Promise<boolean>; step: (s: Step) => void }): Promise<boolean> {
  d.step("connect");
  try {
    await d.connect();
    return true;
  } catch (e) {
    if (!canInstall(errorText(e), thisMac)) throw e;
  }
  d.step("install");
  if (!(await d.install())) return false;
  d.step("connect");
  await d.connect();
  return true;
}
