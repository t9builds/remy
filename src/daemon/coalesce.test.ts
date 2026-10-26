import { expect, test } from "bun:test";
import { coalesce } from "./coalesce";

test("coalesce shares one run per delay, and a longer delay still runs after a shorter one", async () => {
  let runs = 0;
  const later = coalesce(() => runs++);
  later(5);
  later(5);
  later(30);
  later(5);
  await Bun.sleep(15);
  expect(runs).toBe(1);
  await Bun.sleep(30);
  expect(runs).toBe(2);
});
